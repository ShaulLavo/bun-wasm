(function (internal: {
  native: { utf8Encode(value: string): Uint8Array };
  toUint8(value: unknown): Uint8Array;
  concatBytes(chunks: readonly Uint8Array[]): Uint8Array;
}) {
  type BodyRequest = {
    method: string;
    readonly bodyUsed: boolean;
    _body: Uint8Array | null;
    _stream: ReadableStream<unknown> | null;
    _bodyUsed: boolean;
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  type Waiter = { step(): boolean; fail(error: unknown): void };
  type Head = { status: number; statusText?: string; headers: [string, string][]; url?: string; redirected?: boolean; bodyEncoding?: string };
  type HeadOptions = {
    signal?: AbortSignal;
    read(): number | string;
    error(): Error;
    close(): void;
    add(waiter: Waiter): unknown;
    remove(waiter: Waiter): unknown;
  };

  async function readAll(reader: ReadableStreamDefaultReader<unknown>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return internal.concatBytes(chunks);
      chunks.push(typeof chunk.value === "string" ? internal.native.utf8Encode(chunk.value) : internal.toUint8(chunk.value));
    }
  }

  async function requestBody(req: BodyRequest, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw signal.reason;
    if (req.method === "GET" || req.method === "HEAD") return new Uint8Array(0);
    if (req._body === null && !req._stream) return new Uint8Array(0);
    if (!req._stream) return new Uint8Array(await req.arrayBuffer());
    if (req.bodyUsed) throw new TypeError("Body already used");
    const reader = req._stream.getReader();
    req._bodyUsed = true;
    const cancel = (reason: unknown) => { void reader.cancel(reason).catch(() => {}); };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { cancel(signal?.reason); reject(signal?.reason); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([readAll(reader), aborted]);
    } catch (error) {
      if (!signal?.aborted) cancel(error);
      throw error;
    } finally {
      // The reader is kept: like any consumer, the upload leaves the stream locked and used.
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  // A body Bun streams to the server: a ReadableStream with no bytes in memory behind it.
  // Bytes already in memory (a string, a Blob, an untouched stream over either) are sent
  // whole, with a Content-Length.
  function uploadReader(req: BodyRequest): ReadableStreamDefaultReader<unknown> | null {
    if (req.method === "GET" || req.method === "HEAD" || !req._stream || req._body !== null) return null;
    if (req.bodyUsed) throw new TypeError("Body already used");
    const reader = req._stream.getReader();
    req._bodyUsed = true;
    return reader;
  }

  type UploadOptions = {
    handle: number;
    reader: ReadableStreamDefaultReader<unknown>;
    signal?: AbortSignal;
    write(handle: number, bytes: Uint8Array): number;
    end(handle: number): number;
    close(): void;
    add(waiter: Waiter): unknown;
    remove(waiter: Waiter): unknown;
    again: number;
  };

  // Writes `bytes` to the request, waiting while the host's queue is full. False once the
  // request takes no more body: it was answered, failed, redirected or aborted.
  function writeAll(options: UploadOptions, bytes: Uint8Array): Promise<boolean> {
    return new Promise(resolve => {
      let offset = 0;
      const onAbort = () => finish(false);
      const waiter: Waiter = { step: () => write(), fail: () => finish(false) };
      function finish(sent: boolean): true {
        options.remove(waiter);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(sent);
        return true;
      }
      function write(): boolean {
        if (options.signal?.aborted) return finish(false);
        while (offset < bytes.length) {
          const count = options.write(options.handle, bytes.subarray(offset));
          if (count === options.again) return false;
          if (count < 0) return finish(false);
          offset += count;
        }
        return finish(true);
      }
      if (write()) return;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      options.add(waiter);
    });
  }

  const chunkBytes = (chunk: unknown): Uint8Array => typeof chunk === "string" ? internal.native.utf8Encode(chunk) : internal.toUint8(chunk);

  // Streams the body to a fetch_stream handle, one write per chunk; empty chunks send
  // nothing. The returned promise rejects only when the body stream fails, after the
  // request is closed.
  async function sendBody(options: UploadOptions): Promise<void> {
    const cancel = (reason: unknown) => { void options.reader.cancel(reason).catch(() => {}); };
    // An abort also ends a read the stream has not answered yet.
    const onAbort = () => cancel(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const next = await options.reader.read();
        if (options.signal?.aborted) { cancel(options.signal.reason); return; }
        if (next.done) { options.end(options.handle); return; }
        const bytes = chunkBytes(next.value);
        if (bytes.length && !(await writeAll(options, bytes))) {
          cancel(options.signal?.aborted ? options.signal.reason : undefined);
          return;
        }
      }
    } catch (error) {
      options.close();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  function startHead(options: HeadOptions, resolve: (head: Head) => void, reject: (error: unknown) => void): void {
    const waiter = { step, fail };
    const onAbort = () => fail(options.signal?.reason);
    function cleanup(): void {
      options.remove(waiter);
      options.signal?.removeEventListener("abort", onAbort);
    }
    function fail(error: unknown): void {
      cleanup();
      options.close();
      reject(error);
    }
    function step(): boolean {
      const head = options.read();
      if (head === -2) return false;
      if (typeof head === "number") { fail(options.error()); return true; }
      const parsed: Head = JSON.parse(head);
      cleanup();
      resolve(parsed);
      return true;
    }
    if (options.signal?.aborted) { onAbort(); return; }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    options.add(waiter);
  }

  function waitHead(options: HeadOptions): Promise<Head> {
    return new Promise((resolve, reject) => startHead(options, resolve, reject));
  }
  return { requestBody, waitHead, uploadReader, sendBody };
})
