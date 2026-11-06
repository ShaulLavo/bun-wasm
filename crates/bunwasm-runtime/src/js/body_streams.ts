(function (internal: Pick<BunWasm.Internal, "native" | "toUint8">) {
  const PlatformRequest = internal.native.engine === "host" ? globalThis.Request : null;
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
  type ReaderState<T> = { reader: ReadableStreamDefaultReader<T> | null };
  async function nextValue<T>(state: ReaderState<T>): Promise<IteratorResult<T, unknown>> {
    const reader = state.reader;
    if (!reader) return { done: true, value: undefined };
    try {
      const result = await reader.read();
      if (result.done) { state.reader = null; reader.releaseLock(); }
      return result;
    } catch (error) { state.reader = null; reader.releaseLock(); throw error; }
  }
  async function returnValue<T>(state: ReaderState<T>, value: unknown): Promise<IteratorResult<T, unknown>> {
    const reader = state.reader;
    if (!reader) return { done: true, value };
    state.reader = null;
    try { await reader.cancel(value); }
    finally { reader.releaseLock(); }
    return { done: true, value };
  }
  function values<T>(stream: ReadableStream<T>) {
    const state: ReaderState<T> = { reader: stream.getReader() };
    let ongoing: Promise<unknown> = Promise.resolve();
    function enqueue(operation: () => Promise<IteratorResult<T, unknown>>) {
      const result = ongoing.then(operation, operation);
      ongoing = result;
      return result;
    }
    return {
      next: () => enqueue(() => nextValue(state)),
      return: (value?: unknown) => enqueue(() => returnValue(state, value)),
      [Symbol.asyncIterator]() { return this; },
    };
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
  return { remember, tee, clone, transfer, fromAsyncIterable, values, bytes: (stream: ReadableStream<unknown>) => bodies.get(stream) };
})
