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
  function remember<T>(stream: ReadableStream<T>, bytes: Uint8Array): ReadableStream<T> {
    bodies.set(stream, bytes);
    return stream;
  }
  function tee<T>(stream: ReadableStream<T>): [ReadableStream<T>, ReadableStream<T>] {
    const branches = stream.tee();
    const bytes = bodies.get(stream);
    if (bytes) for (const branch of branches) bodies.set(branch, bytes);
    return branches;
  }
  type Body = {
    readonly bodyUsed: boolean;
    readonly body: ReadableStream<unknown> | null;
    _bodyUsed: boolean;
    _body: Uint8Array | null;
    _stream: ReadableStream<unknown> | null;
  };
  function validate(body: Body): void {
    if (body.bodyUsed || body._stream?.locked) throw new TypeError("Body already used");
    if (!PlatformRequest || !body._stream) return;
    const init = { method: "POST", body: body._stream, duplex: "half" };
    new PlatformRequest("http://localhost/", init);
  }
  function clone(body: Body): Uint8Array | ReadableStream<unknown> | null {
    validate(body);
    if (!body._stream) return body._body;
    const [source, copy] = tee(body._stream);
    body._stream = source;
    return copy;
  }
  async function pull(reader: ReadableStreamDefaultReader<unknown>, controller: ReadableStreamDefaultController<unknown>): Promise<void> {
    const { value, done } = await reader.read();
    if (done) { controller.close(); return; }
    controller.enqueue(value);
  }
  function transfer(body: Body): ReadableStream<unknown> | null {
    const stream = body.body;
    if (stream === null) return null;
    validate(body);
    const reader = stream.getReader();
    body._bodyUsed = true;
    return new ReadableStream({
      pull: controller => pull(reader, controller),
      cancel: reason => reader.cancel(reason),
    });
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
  // Body.textStream() (Bun's Body.rs to_text_readable_stream): the body as decoded
  // UTF-8 strings. A character split across chunks is held until it is complete.
  async function pullText(reader: ReadableStreamDefaultReader<unknown>, decoder: TextDecoder, controller: ReadableStreamDefaultController<string>): Promise<void> {
    for (let next = await reader.read(); ; next = await reader.read()) {
      if (next.done) {
        const tail = decoder.decode();
        if (tail) controller.enqueue(tail);
        controller.close();
        return;
      }
      const text = typeof next.value === "string" ? next.value : decoder.decode(internal.toUint8(next.value as Uint8Array), { stream: true });
      if (text) { controller.enqueue(text); return; }
    }
  }
  function textStream(body: Body): ReadableStream<string> {
    if (body.bodyUsed || body._stream?.locked) {
      throw Object.assign(new TypeError("Body is disturbed or locked"), { code: "ERR_BODY_ALREADY_USED" });
    }
    const stream = body.body;
    if (stream === null) return new ReadableStream<string>({ start: controller => controller.close() });
    const reader = stream.getReader();
    body._bodyUsed = true;
    const decoder = new TextDecoder();
    return new ReadableStream<string>({
      pull: controller => pullText(reader, decoder, controller),
      cancel: reason => reader.cancel(reason),
    });
  }
  return { remember, tee, clone, transfer, textStream, fromAsyncIterable, consume, drain, consumedStream, adoptable, bytes: (stream: ReadableStream<unknown>) => bodies.get(stream) };
})
