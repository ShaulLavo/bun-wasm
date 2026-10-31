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
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
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
  return { requestBody, waitHead };
})
