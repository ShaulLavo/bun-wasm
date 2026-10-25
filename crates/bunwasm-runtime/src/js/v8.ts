(function (internal: BunWasm.Internal) {
  "use strict";
  const { Buffer } = internal.require("buffer");
  const prefix = "bun-wasm:structured\0";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const codec = internal.require("worker_codec").create({
    buffer: { isBuffer: value => Buffer.isBuffer(value), from: bytes => Buffer.from(bytes) },
    isPort: value => Boolean(internal.isMessagePort?.(value)),
    prepare() { throw new DOMException("MessagePort cannot be serialized", "DataCloneError"); },
    restore() { throw new DOMException("MessagePort cannot be deserialized", "DataCloneError"); },
    activate() {},
  });
  function serialize(value: unknown): BunWasm.BufferBytes {
    return Buffer.from(prefix + JSON.stringify(codec.encode(value)));
  }
  function deserialize(value: unknown): unknown {
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new TypeError("First argument must be an ArrayBuffer");
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const text = decoder.decode(bytes);
    if (!text.startsWith(prefix)) throw new Error("Unable to deserialize data");
    return codec.decode(JSON.parse(text.slice(prefix.length)));
  }
  return { serialize, deserialize };
})
