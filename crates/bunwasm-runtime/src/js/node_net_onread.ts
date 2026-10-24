(function (internal: Pick<BunWasm.Internal, "handleUncaught" | "native">) {
  type ReadBuffer = Uint8Array | true;
  const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
  function isReadBuffer(value: unknown): value is Uint8Array {
    return ArrayBuffer.isView(value) && typedArrayTag?.call(value) === "Uint8Array";
  }
  function allocate(factory: (() => unknown) | null, previous: ReadBuffer): ReadBuffer {
    const value = factory?.();
    return isReadBuffer(value) ? value : previous;
  }
  return function onread(value: unknown) {
    if (!value) return null;
    if (typeof value !== "object") throw new TypeError("onread must be an object");
    if (!("callback" in value) || typeof value.callback !== "function") throw new TypeError("onread.callback must be a function");
    if (!("buffer" in value)) return null;
    const supplied = value.buffer;
    if (!(isReadBuffer(supplied)) && typeof supplied !== "function") return null;
    const factory = typeof supplied === "function" ? () => supplied() : null;
    let buffer = isReadBuffer(supplied) ? supplied : allocate(factory, true);
    const fn = value.callback;
    return {
      capacity(): number {
        if (buffer === true) return 65536;
        if (buffer.length !== 0) return buffer.length;
        throw Object.assign(new Error("read ENOBUFS"), { code: "ENOBUFS", syscall: "read" });
      },
      deliver(chunk: Uint8Array): unknown {
        if (buffer !== true) buffer.set(chunk);
        let result: unknown;
        try {
          result = Reflect.apply(fn, undefined, [chunk.length, buffer]);
          buffer = allocate(factory, buffer);
        } catch (error) {
          if (!internal.handleUncaught(error)) internal.native.exit(1);
        }
        return result;
      },
    };
  };
})
