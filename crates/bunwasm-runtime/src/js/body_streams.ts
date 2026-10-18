(function () {
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
    _body: Uint8Array | null;
    _stream: ReadableStream<unknown> | null;
  };
  function clone(body: Body): Uint8Array | ReadableStream<unknown> | null {
    if (body.bodyUsed || body._stream?.locked) throw new TypeError("Body already used");
    if (!body._stream) return body._body;
    const [source, copy] = tee(body._stream);
    body._stream = source;
    return copy;
  }
  return { remember, tee, clone, bytes: (stream: ReadableStream<unknown>) => bodies.get(stream) };
})
