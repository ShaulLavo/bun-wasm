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
  async function* iterableChunks(source: AsyncIterable<unknown>) {
    for await (const chunk of source) {
      yield typeof chunk === "string" ? internal.native.utf8Encode(chunk) : internal.toUint8(chunk);
    }
  }
  function fromAsyncIterable(source: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
    const iterator = iterableChunks(source);
    return new ReadableStream({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) { controller.close(); return; }
        controller.enqueue(next.value);
      },
      async cancel() { await iterator.return(undefined); },
    });
  }
  return { remember, tee, clone, transfer, fromAsyncIterable, bytes: (stream: ReadableStream<unknown>) => bodies.get(stream) };
})
