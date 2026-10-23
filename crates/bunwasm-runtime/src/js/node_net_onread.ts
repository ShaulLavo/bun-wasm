(function (internal: Pick<BunWasm.Internal, "handleUncaught" | "native">) {
  type ReadBuffer = Uint8Array | true;
  function allocate(factory: (() => unknown) | null, previous: ReadBuffer): ReadBuffer {
    const value = factory?.();
    return value instanceof Uint8Array ? value : previous;
  }
  function callback(fn: Function, count: number, buffer: ReadBuffer): unknown {
    try { return Reflect.apply(fn, undefined, [count, buffer]); }
    catch (error) { if (!internal.handleUncaught(error)) internal.native.exit(1); }
  }
  return function onread(value: unknown) {
    if (!value) return null;
    if (typeof value !== "object") throw new TypeError("onread must be an object");
    if (!("callback" in value) || typeof value.callback !== "function") throw new TypeError("onread.callback must be a function");
    if (!("buffer" in value)) return null;
    const supplied = value.buffer;
    if (!(supplied instanceof Uint8Array) && typeof supplied !== "function") return null;
    const factory = typeof supplied === "function" ? () => supplied() : null;
    let buffer = supplied instanceof Uint8Array ? supplied : allocate(factory, true);
    const fn = value.callback;
    return {
      capacity(): number {
        if (buffer === true) return 65536;
        if (buffer.length !== 0) return buffer.length;
        throw Object.assign(new Error("read ENOBUFS"), { code: "ENOBUFS", syscall: "read" });
      },
      deliver(chunk: Uint8Array): unknown {
        if (buffer !== true) buffer.set(chunk);
        const result = callback(fn, chunk.length, buffer);
        buffer = allocate(factory, buffer);
        return result;
      },
    };
  };
})
