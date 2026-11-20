// Bun pins the buffers an fs call reads (the data of write, writev and writeFile, and a
// Buffer path) until the call completes. JSC cannot detach a pinned ArrayBuffer:
// transfer() and transferToFixedLength() return a copy and leave the original
// attached (ArrayBuffer::transferTo in JavaScriptCore/runtime/ArrayBuffer.cpp). The
// engines here have no pins, so this module counts them and gives those two methods the
// same copy-instead-of-detach behavior for a pinned buffer. Loading the module installs
// the methods; until an fs call pins a buffer the original methods run unchanged. A
// reference to an original method captured before the first pin still detaches.
(function () {
  "use strict";
  type Transfer = (this: ArrayBuffer, newLength?: number) => ArrayBuffer;
  type Resizable = ArrayBuffer & { readonly resizable?: boolean; readonly maxByteLength?: number };

  const pins = new WeakMap<ArrayBuffer, number>();
  const prototype = ArrayBuffer.prototype as unknown as Record<string, Transfer | undefined>;
  install("transfer", true);
  install("transferToFixedLength", false);

  // A Proxy over the original method, not a new function: Function.prototype.toString
  // still prints it as native code ("[native code]" checks such as core-js's keep their
  // answer), and its name, length and non-constructor behavior are the original's.
  function install(name: string, preserveResizability: boolean) {
    const original = prototype[name];
    if (typeof original !== "function") return;
    const replacement = new Proxy(original, {
      apply(target, receiver: ArrayBuffer, args: [number?]) {
        if (!pins.has(receiver)) return Reflect.apply(target, receiver, args);
        return copyOf(receiver, args[0], preserveResizability);
      },
    });
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
    // Unary plus, as ToIndex does: a BigInt length is a TypeError, not a number.
    const index = Math.trunc(+(value as number)) || 0;
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
