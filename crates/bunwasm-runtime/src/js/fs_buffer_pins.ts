// Bun pins the buffers an fs call reads (the data of write, writev and writeFile, and a
// Buffer path) until the call completes. JSC cannot detach a pinned ArrayBuffer:
// transfer() and transferToFixedLength() return a copy and leave the original
// attached (ArrayBuffer::transferTo in JavaScriptCore/runtime/ArrayBuffer.cpp). The
// engines here have no pins, so this module counts them and gives those two methods the
// same copy-instead-of-detach behavior for a pinned buffer. Loading the module installs
// the methods; until an fs call pins a buffer the original methods run unchanged.
(function () {
  "use strict";
  type Transfer = (this: ArrayBuffer, newLength?: number) => ArrayBuffer;
  type Resizable = ArrayBuffer & { readonly resizable?: boolean; readonly maxByteLength?: number };

  const pins = new WeakMap<ArrayBuffer, number>();
  const prototype = ArrayBuffer.prototype as unknown as Record<string, Transfer | undefined>;
  install("transfer", true);
  install("transferToFixedLength", false);

  function install(name: string, preserveResizability: boolean) {
    const original = prototype[name];
    if (typeof original !== "function") return;
    const replacement = {
      [name](this: ArrayBuffer, ...args: [number?]) {
        if (!pins.has(this)) return Reflect.apply(original, this, args);
        return copyOf(this, args[0], preserveResizability);
      },
    }[name];
    Object.defineProperty(prototype, name, { value: replacement, writable: true, enumerable: false, configurable: true });
  }

  function copyOf(buffer: Resizable, newLength: unknown, preserveResizability: boolean): ArrayBuffer {
    const length = newLength === undefined ? buffer.byteLength : toIndex(newLength);
    const options = preserveResizability && buffer.resizable ? { maxByteLength: buffer.maxByteLength } : undefined;
    const copy = new (ArrayBuffer as new (length: number, options?: object) => ArrayBuffer)(length, options);
    new Uint8Array(copy).set(new Uint8Array(buffer, 0, Math.min(length, buffer.byteLength)));
    return copy;
  }

  function toIndex(value: unknown): number {
    const index = Math.trunc(Number(value)) || 0;
    if (index < 0 || index > Number.MAX_SAFE_INTEGER) throw new RangeError("Invalid array buffer length");
    return index;
  }

  function backing(value: unknown): ArrayBuffer | null {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) return value.buffer;
    return null;
  }

  function release(buffer: ArrayBuffer) {
    const count = pins.get(buffer)!;
    if (count === 1) pins.delete(buffer);
    else pins.set(buffer, count - 1);
  }

  // Pin the buffers behind the given values (views, ArrayBuffers, or arrays of them).
  // Returns the function that releases them; calling it again does nothing.
  function pin(values: readonly unknown[]): () => void {
    const buffers: ArrayBuffer[] = [];
    for (const value of values) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        const buffer = backing(item);
        if (buffer === null) continue;
        pins.set(buffer, (pins.get(buffer) ?? 0) + 1);
        buffers.push(buffer);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      buffers.forEach(release);
    };
  }

  return { pin };
})
