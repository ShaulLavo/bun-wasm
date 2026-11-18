// Bun's ReadableStream.prototype text/json/bytes/blob (JSReadableStream.cpp) and
// Bun.readableStreamToArray (BunStreamConsumers.cpp): read every chunk, then convert.
// bun.js installs them on the runtime's ReadableStream, which on the Browser engine
// is the host's own class.
(function (internal: BunWasm.Internal) {
  "use strict";

  function lockedError(): TypeError {
    return Object.assign(new TypeError("Invalid state: ReadableStream is locked"), { code: "ERR_INVALID_STATE" });
  }

  async function readChunks(stream: ReadableStream<unknown>): Promise<unknown[]> {
    const reader = stream.getReader();
    const chunks: unknown[] = [];
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
      return chunks;
    } finally { reader.releaseLock(); }
  }

  function readableStreamToArray(stream: ReadableStream<unknown>): Promise<unknown[]> {
    if (stream.locked) return Promise.reject(lockedError());
    return readChunks(stream);
  }

  async function streamBytes(stream: ReadableStream<unknown>): Promise<Uint8Array<ArrayBuffer>> {
    const chunks = await readableStreamToArray(stream);
    return internal.concatBytes(chunks.map(chunk => typeof chunk === "string" ? internal.native.utf8Encode(chunk) : internal.toUint8(chunk as Uint8Array)));
  }

  return function install(Stream: typeof ReadableStream) {
    const receiver = (value: unknown): ReadableStream<unknown> => {
      if (value instanceof Stream) return value;
      throw Object.assign(new TypeError('Value of "this" must be of type ReadableStream'), { code: "ERR_INVALID_THIS" });
    };
    const methods = {
      text(this: unknown) { return streamBytes(receiver(this)).then(bytes => new TextDecoder().decode(bytes)); },
      json(this: unknown) { return streamBytes(receiver(this)).then(bytes => JSON.parse(new TextDecoder().decode(bytes))); },
      bytes(this: unknown) { return streamBytes(receiver(this)); },
      blob(this: unknown) { return streamBytes(receiver(this)).then(bytes => new Blob([bytes])); },
    };
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(Stream.prototype, name, { value, writable: true, enumerable: true, configurable: true });
    }
    return { readableStreamToArray };
  };
})
