(function (internal: { toUint8(value: unknown): Uint8Array }) {
  "use strict";

  const { toUint8 } = internal;
  const Bytes = Uint8Array;
  const typedArrayPrototype = Object.getPrototypeOf(Bytes.prototype);
  const byteLength = accessor("byteLength");
  const buffer = accessor("buffer");
  const byteOffset = accessor("byteOffset");
  const set = Bytes.prototype.set;
  const values = Bytes.prototype.values;

  function accessor(name: string) {
    const getter = Object.getOwnPropertyDescriptor(typedArrayPrototype, name)?.get;
    if (!getter) throw new TypeError(`Missing typed-array ${name} getter`);
    return getter;
  }

  function maximumLength(value: unknown): number {
    if (typeof value !== "number" || value === Infinity) return Infinity;
    if (Number.isNaN(value) || value < 0) throw new RangeError("Maximum length must be >= 0");
    return value >>> 0;
  }

  // Native Bun's JSC typed arrays stop at 2^32 bytes. A 64-bit host engine
  // (Browser's V8) would otherwise reserve the full size and copy every byte.
  const kMaxLength = 4294967296;

  function allocate(length: number): Uint8Array<ArrayBuffer> {
    if (length > kMaxLength) throw new TypeError("Failed to allocate ArrayBuffer");
    try { return new Bytes(length); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new TypeError("Failed to allocate ArrayBuffer");
    }
  }

  return function concatArrayBuffers(buffers: readonly unknown[], maximum?: unknown, asUint8Array?: unknown): ArrayBuffer | Uint8Array<ArrayBuffer> {
    const limit = maximumLength(maximum);
    const chunks = buffers.map(toUint8);
    let length = 0;
    for (const chunk of chunks) {
      values.call(chunk);
      length += byteLength.call(chunk);
    }
    const outputLength = Math.min(length, limit);
    const output = allocate(outputLength);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset === outputLength) break;
      const length = byteLength.call(chunk);
      const count = Math.min(length, outputLength - offset);
      if (count === 0) continue;
      const source = count === length ? chunk : new Bytes(buffer.call(chunk), byteOffset.call(chunk), count);
      set.call(output, source, offset);
      offset += count;
    }
    return asUint8Array ? output : buffer.call(output);
  };
})
