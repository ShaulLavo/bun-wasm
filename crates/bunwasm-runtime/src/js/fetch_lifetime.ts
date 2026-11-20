(function (internal: {
  native: { utf8Encode(value: string): Uint8Array };
  toUint8(value: unknown): Uint8Array;
  concatBytes(chunks: readonly Uint8Array[]): Uint8Array;
}) {
  type BodyRequest = {
    method: string;
    readonly bodyUsed: boolean;
    _body: Uint8Array | null;
    _blob: Blob | null;
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
    if (req._body === null && !req._stream && !req._blob) return new Uint8Array(0);
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
  // whole, with a Content-Length. The stream stays unlocked and the body unused until the
  // upload starts (lockUpload), as in Bun.
  function uploadStream(req: BodyRequest): ReadableStream<unknown> | null {
    if (req.method === "GET" || req.method === "HEAD" || !req._stream || req._body !== null || req._blob) return null;
    if (req.bodyUsed) throw new TypeError("Body already used");
    return req._stream;
  }
  function lockUpload(req: BodyRequest, stream: ReadableStream<unknown>): ReadableStreamDefaultReader<unknown> {
    const reader = stream.getReader();
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

  // Bun's error for a body chunk that is neither a string nor bytes.
  function chunkBytes(chunk: unknown): Uint8Array {
    if (typeof chunk === "string") return internal.native.utf8Encode(chunk);
    if (ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer || typeof SharedArrayBuffer === "function" && chunk instanceof SharedArrayBuffer) return internal.toUint8(chunk);
    throw Object.assign(new TypeError("write() expects a string, ArrayBufferView, or ArrayBuffer"), { code: "ERR_INVALID_ARG_TYPE" });
  }

  // Streams the body to a fetch_stream handle, one write per chunk; empty chunks send
  // nothing. The returned promise rejects only when the body stream fails, after the
  // request is closed. Bun cancels the source without a reason.
  async function sendBody(options: UploadOptions): Promise<void> {
    const cancel = () => { void options.reader.cancel(undefined).catch(() => {}); };
    // An abort also ends a read the stream has not answered yet.
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const next = await options.reader.read();
        if (options.signal?.aborted) { cancel(); return; }
        if (next.done) { options.end(options.handle); return; }
        const bytes = chunkBytes(next.value);
        if (bytes.length && !(await writeAll(options, bytes))) {
          cancel();
          return;
        }
      }
    } catch (error) {
      options.close();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
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
  return { requestBody, waitHead, uploadStream, lockUpload, sendBody };
})
