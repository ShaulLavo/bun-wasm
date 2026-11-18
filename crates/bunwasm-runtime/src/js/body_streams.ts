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
  return { remember, tee, clone, transfer, textStream, fromAsyncIterable, consume, bytes: (stream: ReadableStream<unknown>) => bodies.get(stream) };
})
