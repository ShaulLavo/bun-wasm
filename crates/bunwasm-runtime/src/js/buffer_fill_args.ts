(function () {
  "use strict";

  const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
  const readTypedArrayTag = Object.getOwnPropertyDescriptor(typedArrayProto, Symbol.toStringTag)!.get!;
  const readTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayProto, "buffer")!.get!;
  const readTypedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayProto, "byteOffset")!.get!;
  const readTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayProto, "byteLength")!.get!;
  const readDataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!;
  const readDataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!;
  const readDataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!;

  function isTypedArray(value: unknown): value is ArrayBufferView {
    return ArrayBuffer.isView(value) && readTypedArrayTag.call(value) !== undefined;
  }

  function intrinsicByteLength(value: unknown): number {
    if (isTypedArray(value)) return readTypedArrayByteLength.call(value);
    if (ArrayBuffer.isView(value)) {
      try {
        return readDataViewByteLength.call(value);
      } catch {
        return 0;
      }
    }
    return typeof (value as { length?: unknown })?.length === "number" ? (value as { length: number }).length : 0;
  }

  function readViewBytes(value: ArrayBufferView): Uint8Array | null {
    if (isTypedArray(value)) {
      const byteLength = readTypedArrayByteLength.call(value);
      if (byteLength === 0) return null;
      if (readTypedArrayTag.call(value) === "Uint8Array") return value as Uint8Array;
      return new Uint8Array(readTypedArrayBuffer.call(value), readTypedArrayOffset.call(value), byteLength);
    }
    let byteLength: number;
    try {
      byteLength = readDataViewByteLength.call(value);
    } catch {
      return null;
    }
    if (byteLength === 0) return null;
    return new Uint8Array(readDataViewBuffer.call(value), readDataViewOffset.call(value), byteLength);
  }

  function isDetachedZeroLength(value: unknown): boolean {
    if (!isTypedArray(value)) return false;
    return readTypedArrayByteLength.call(value) === 0 && Boolean(readTypedArrayBuffer.call(value).detached);
  }

  function prepareSearch(buf: unknown, byteOffset: unknown, encoding: unknown, forward: boolean) {
    const initialLength = intrinsicByteLength(buf);
    let enc = encoding;
    let offset = byteOffset;
    if (typeof offset === "string") {
      enc = offset;
      offset = NaN;
    } else {
      offset = +(offset as number);
      if ((offset as number) > 0x7fffffff) offset = 0x7fffffff;
      else if ((offset as number) < -0x80000000) offset = -0x80000000;
    }
    if (offset !== offset) offset = forward ? 0 : initialLength;
    const coercedOffset = Math.trunc(offset as number) || 0;
    const encodingText = enc === undefined ? undefined : `${enc}`;
    return { offset: coercedOffset, encodingText };
  }

  function fillArgs(
    validateEncoding: (encoding: unknown) => string,
    value: unknown,
    size: number,
    offset?: unknown,
    end?: unknown,
    encoding?: unknown,
  ) {
    if (typeof value !== "string")
      return offset === undefined ? { start: 0, stop: size } : { start: offset, stop: end };
    if (offset === undefined || typeof offset === "string")
      return { start: 0, stop: size, encoding: validateEncoding(offset) };
    if (typeof end === "string")
      return { start: offset, stop: size, encoding: validateEncoding(end) };
    return { start: offset, stop: end, encoding: validateEncoding(encoding) };
  }

  return Object.assign(fillArgs, {
    intrinsicByteLength,
    readViewBytes,
    isDetachedZeroLength,
    prepareSearch,
  });
});
