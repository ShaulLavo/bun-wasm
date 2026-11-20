(function (internal: Pick<BunWasm.Internal, "native" | "toUint8">) {
  const PlatformRequest = internal.native.engine === "host" ? globalThis.Request : null;
  // The polyfill streams keep a `_disturbed` flag; a host's native streams do not expose
  // theirs. On the host engine, set the same flag when a reader reads or the stream is
  // cancelled, piped or iterated, so bodyUsed and node:stream's isDisturbed see it.
  function markDisturbed(stream: unknown): void {
    if (!stream || typeof stream !== "object" || Reflect.get(stream, "_disturbed") === true) return;
    Object.defineProperty(stream, "_disturbed", { value: true, configurable: true });
  }
  function wrapMethod(target: object, name: string | symbol, before: (self: object, args: unknown[]) => void): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const original: unknown = descriptor?.value;
    if (!descriptor || typeof original !== "function") return;
    const wrapped = { [name](this: object, ...args: unknown[]) { before(this, args); return Reflect.apply(original, this, args); } }[name as string];
    Object.defineProperty(target, name, Object.assign(descriptor, { value: wrapped }));
  }
  function trackHostDisturbance(): void {
    const Stream = globalThis.ReadableStream;
    const marker = Symbol.for("bun-wasm.disturbance-tracked");
    if (typeof Stream !== "function" || Reflect.get(Stream.prototype, marker)) return;
    Object.defineProperty(Stream.prototype, marker, { value: true });
    const owners = new WeakMap<object, object>();
    const originalGetReader: unknown = Object.getOwnPropertyDescriptor(Stream.prototype, "getReader")?.value;
    if (typeof originalGetReader === "function") {
      const wrapped = function getReader(this: object, ...args: unknown[]) {
        const reader: unknown = Reflect.apply(originalGetReader, this, args);
        if (reader && typeof reader === "object") owners.set(reader, this);
        return reader;
      };
      Object.defineProperty(Stream.prototype, "getReader", { value: wrapped, writable: true, configurable: true });
    }
    for (const Reader of [globalThis.ReadableStreamDefaultReader, globalThis.ReadableStreamBYOBReader]) {
      if (typeof Reader !== "function") continue;
      for (const name of ["read", "cancel"]) wrapMethod(Reader.prototype, name, self => markDisturbed(owners.get(self)));
    }
    const disturbUnlocked = (self: object) => { if (Reflect.get(self, "locked") !== true) markDisturbed(self); };
    // values and [Symbol.asyncIterator] are one function in the platform; keep them one.
    const sharedIterator = Reflect.get(Stream.prototype, "values") === Reflect.get(Stream.prototype, Symbol.asyncIterator);
    for (const name of ["cancel", "pipeTo", "pipeThrough", Symbol.asyncIterator]) wrapMethod(Stream.prototype, name, disturbUnlocked);
    if (sharedIterator) Object.defineProperty(Stream.prototype, "values", { value: Reflect.get(Stream.prototype, Symbol.asyncIterator) });
    else wrapMethod(Stream.prototype, "values", disturbUnlocked);
  }
  if (internal.native.engine === "host") trackHostDisturbance();
  const bodies = new WeakMap<ReadableStream<unknown>, Uint8Array>();
  // The type of the Blob behind a stream over its bytes, which a body built from the stream keeps.
  const types = new WeakMap<ReadableStream<unknown>, string>();
  function remember<T>(stream: ReadableStream<T>, bytes: Uint8Array, type?: string | null): ReadableStream<T> {
    bodies.set(stream, bytes);
    if (type) types.set(stream, type);
    return stream;
  }
  function rememberAs<T>(stream: ReadableStream<T>, source: ReadableStream<unknown>): ReadableStream<T> {
    const bytes = bodies.get(source);
    return bytes ? remember(stream, bytes, types.get(source)) : stream;
  }
  // Bun's tee gives both branches the same chunk objects. The streams standard copies each
  // chunk of a byte stream (a fetch() or Bun.serve body) for the second branch, so a byte
  // stream is read through a plain stream first, whose tee shares chunks.
  function isByteStream(stream: ReadableStream<unknown>): boolean {
    try {
      stream.getReader({ mode: "byob" }).releaseLock();
      return true;
    } catch {
      return false;
    }
  }
  function plain<T>(stream: ReadableStream<T>): ReadableStream<T> {
    if (!isByteStream(stream)) return stream;
    const reader = stream.getReader();
    return new ReadableStream<T>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: reason => reader.cancel(reason),
    }, { highWaterMark: 0 });
  }
  function tee<T>(stream: ReadableStream<T>): [ReadableStream<T>, ReadableStream<T>] {
    const branches = plain(stream).tee();
    for (const branch of branches) rememberAs(branch, stream);
    return branches;
  }
  // The Bun.file() behind a stream it made: a body built from the stream keeps the file, as Bun
  // lifts the Blob back out of its own stream.
  const files = new WeakMap<ReadableStream<unknown>, Blob>();
  function rememberFile<T>(stream: ReadableStream<T>, file: Blob): ReadableStream<T> {
    files.set(stream, file);
    return stream;
  }
  type Body = {
    readonly bodyUsed: boolean;
    readonly body: ReadableStream<unknown> | null;
    _bodyUsed: boolean;
    _body: Uint8Array | null;
    _stream: ReadableStream<unknown> | null;
    // A Bun.file() body, read when the body is used.
    _blob: Blob | null;
  };
  function unusable(): TypeError {
    return Object.assign(new TypeError("Body is disturbed or locked"), { code: "ERR_BODY_ALREADY_USED" });
  }
  function lockedStream(): TypeError {
    return Object.assign(new TypeError("Invalid state: ReadableStream is locked"), { code: "ERR_INVALID_STATE" });
  }
  function checkPlatform(stream: ReadableStream<unknown>): void {
    if (!PlatformRequest) return;
    const init = { method: "POST", body: stream, duplex: "half" };
    new PlatformRequest("http://localhost/", init);
  }
  // Read a stream to its end and keep its reader: the stream ends closed, disturbed and locked.
  // A stream over bytes already in memory closes on the first read, before this returns.
  function finish(stream: ReadableStream<unknown>): void {
    void drain(stream, () => {}).catch(() => {});
  }
  // Fetch's clone() (Bun's "Body is disturbed or locked" when this is unusable). An unread
  // stream over bytes in memory is not teed: both bodies take the bytes, as Bun lifts them
  // out of a native stream, and the old stream ends consumed.
  // A Bun.file() body is not teed either: both bodies keep the file and read it when used, and
  // an unread stream the file made ends locked.
  function clone(body: Body): Uint8Array | Blob | ReadableStream<unknown> | null {
    if (body.bodyUsed || body._stream?.locked) throw unusable();
    const stream = body._stream;
    if (!stream) return body._blob ? sharedFile(body, body._blob) : body._body;
    if (body._blob && files.get(stream) === body._blob) {
      void stream.getReader().cancel().catch(() => {});
      body._stream = null;
      return body._blob;
    }
    if (body._body && bodies.get(stream) === body._body) {
      finish(stream);
      body._stream = null;
      return body._body;
    }
    checkPlatform(stream);
    const [source, copy] = tee(stream);
    body._stream = source;
    return copy;
  }
  // A file given by descriptor (Bun.stdin, Bun.file(fd)) can be read only once, so a clone
  // tees a stream over it, as Bun does: both bodies read it as it arrives, and a pipe that
  // never ends (`yes |`) never has to be read whole.
  function sharedFile(body: Body, file: Blob): Blob | ReadableStream<unknown> {
    if (!(file as Blob & { _readsOnce(): boolean })._readsOnce()) return file;
    const [kept, copy] = tee(file.stream());
    body._blob = null;
    body._stream = kept;
    return copy;
  }
  // new Request(request): Bun copies the source's body as clone() does, so the source keeps
  // its own. A used body copies as used (a stream that is already read, or empty bytes for a
  // body that was in memory); only a stream someone else holds throws.
  const usedBody = Symbol("a used stream body");
  function transfer(body: Body): Uint8Array | Blob | ReadableStream<unknown> | null | typeof usedBody {
    const stream = body._stream;
    if (body._body === null && !stream && !body._blob) return null;
    // A body read through text() and the like keeps its reader, so this comes before the lock.
    if (body.bodyUsed) return body._body !== null || body._blob ? new Uint8Array(0) : usedBody;
    // Bun tees the source's stream here, and the tee reports the lock.
    if (stream?.locked) throw lockedStream();
    // A host engine's own stream can be disturbed without our flag; its Request says so.
    try {
      if (stream) checkPlatform(stream);
    } catch {
      return usedBody;
    }
    return clone(body);
  }
  async function visitChunk<T>(reader: ReadableStreamDefaultReader<T>, chunk: T, visit: (chunk: T) => void): Promise<void> {
    try { visit(chunk); }
    catch (error) {
      try { await reader.cancel(); } catch {}
      throw error;
    }
  }
  async function consume<T>(stream: ReadableStream<T>, visit: (chunk: T) => void): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        await visitChunk(reader, next.value, visit);
      }
    } finally { reader.releaseLock(); }
  }
  // Fetch's "fully read" for a body: the reader is never released, so the stream stays
  // locked, disturbed and closed (or errored) once the body is consumed.
  async function drain<T>(stream: ReadableStream<T>, visit: (chunk: T) => void): Promise<void> {
    const reader = stream.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) await visitChunk(reader, next.value, visit);
  }
  // The stream a body read without one would have had: closed, disturbed and locked.
  function consumedStream(): ReadableStream<Uint8Array> {
    const stream = new ReadableStream<Uint8Array>({ start: controller => controller.close() });
    void stream.getReader().read();
    return stream;
  }
  // A ReadableStream body init that something already read or holds cannot become a body.
  function adoptable(stream: ReadableStream<unknown>): ReadableStream<unknown> {
    if (stream.locked || Reflect.get(stream, "_disturbed") === true) throw new TypeError("Body object should not be disturbed or locked");
    return stream;
  }
  type IterableBody = { iterator: AsyncIterator<unknown>; closed: boolean };
  async function closeIterable(body: IterableBody): Promise<void> {
    if (body.closed) return;
    body.closed = true;
    await body.iterator.return?.();
  }
  async function pullIterable(body: IterableBody, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const next = await body.iterator.next();
    if (body.closed) return;
    if (next.done) { body.closed = true; controller.close(); return; }
    try {
      const chunk = next.value;
      const bytes = typeof chunk === "string" ? internal.native.utf8Encode(chunk) : internal.toUint8(chunk);
      if (!body.closed) controller.enqueue(bytes);
    } catch (error) {
      try { await closeIterable(body); } catch {}
      throw error;
    }
  }
  function fromAsyncIterable(source: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
    const iterator = source[Symbol.asyncIterator]();
    if (!iterator || (typeof iterator !== "object" && typeof iterator !== "function")) throw new TypeError("Expected an async generator");
    if (typeof iterator.next !== "function") throw new TypeError("Expected an async generator");
    const body: IterableBody = { iterator, closed: false };
    return new ReadableStream({
      pull: controller => pullIterable(body, controller),
      cancel: () => closeIterable(body),
    }, { highWaterMark: 0 });
  }
  // Body.textStream() (Bun's readableStreamTextDecodeFrom in ReadableStreamOperations.cpp):
  // the body as decoded UTF-8 strings. A character split across chunks is held until it is
  // complete. The source's reader is released once the source closes, the output is
  // cancelled, or a chunk is not a BufferSource, so the source ends unlocked.
  type TextSource = { reader: ReadableStreamDefaultReader<unknown>; decoder: TextDecoder; released: boolean };
  function releaseText(source: TextSource): void {
    if (source.released) return;
    source.released = true;
    source.reader.releaseLock();
  }
  function isBufferSource(value: unknown): value is ArrayBufferView | ArrayBuffer {
    return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;
  }
  function rejectChunk(source: TextSource, controller: ReadableStreamDefaultController<string>): void {
    const error = new TypeError("Body.textStream() received a chunk that is not a BufferSource");
    controller.error(error);
    source.reader.cancel(error).catch(() => {});
    releaseText(source);
  }
  async function pullText(source: TextSource, controller: ReadableStreamDefaultController<string>): Promise<void> {
    for (let next = await source.reader.read(); ; next = await source.reader.read()) {
      // The output was cancelled while this read was pending.
      if (source.released) return;
      if (next.done) {
        const tail = source.decoder.decode();
        if (tail) controller.enqueue(tail);
        controller.close();
        releaseText(source);
        return;
      }
      if (!isBufferSource(next.value)) return rejectChunk(source, controller);
      const text = source.decoder.decode(internal.toUint8(next.value), { stream: true });
      if (text) { controller.enqueue(text); return; }
    }
  }
  function cancelText(source: TextSource, reason: unknown): Promise<void> {
    if (source.released) return Promise.resolve();
    const result = source.reader.cancel(reason);
    releaseText(source);
    return result;
  }
  function textStream(body: Body): ReadableStream<string> {
    if (body.bodyUsed || body._stream?.locked) {
      throw Object.assign(new TypeError("Body is disturbed or locked"), { code: "ERR_BODY_ALREADY_USED" });
    }
    const stream = body.body;
    if (stream === null) return new ReadableStream<string>({ start: controller => controller.close() });
    const source: TextSource = { reader: stream.getReader(), decoder: new TextDecoder(), released: false };
    body._bodyUsed = true;
    return new ReadableStream<string>({
      pull: controller => pullText(source, controller),
      cancel: reason => cancelText(source, reason),
    }, { highWaterMark: 0 });
  }
  return { remember, tee, clone, transfer, textStream, fromAsyncIterable, consume, drain, consumedStream, adoptable, bytes: (stream: ReadableStream<unknown>) => bodies.get(stream), type: (stream: ReadableStream<unknown>) => types.get(stream), rememberFile, blobOf: (stream: ReadableStream<unknown>) => files.get(stream), usedBody };
})
