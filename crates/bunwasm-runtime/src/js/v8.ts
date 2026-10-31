(function (internal: BunWasm.Internal) {
  "use strict";
  const { Buffer } = internal.require("buffer");
  const prefix = "bun-wasm:structured\0";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const codec = internal.require("worker_codec").create({
    buffer: { isBuffer: value => Buffer.isBuffer(value), from: (buffer, offset, length) => Buffer.from(buffer, offset, length) },
    isPort: value => Boolean(internal.isMessagePort?.(value)),
    prepare() { throw new DOMException("MessagePort cannot be serialized", "DataCloneError"); },
    restore() { throw new DOMException("MessagePort cannot be deserialized", "DataCloneError"); },
    activate() {},
  });
  function serialize(value: unknown): BunWasm.BufferBytes {
    return Buffer.from(prefix + JSON.stringify(codec.encode(value)));
  }
  function inputBytes(value: unknown) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    try {
      Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value);
    } catch {
      throw new TypeError("First argument must be an ArrayBuffer");
    }
    return new Uint8Array(value as ArrayBuffer);
  }
  function deserialize(value: unknown): unknown {
    const bytes = inputBytes(value);
    const text = decoder.decode(bytes);
    if (!text.startsWith(prefix)) throw new Error("Unable to deserialize data");
    return codec.decode(JSON.parse(text.slice(prefix.length)));
  }
  return { serialize, deserialize };
})
