const clone = globalThis.structuredClone.bind(globalThis);
const memoryBuffers = new WeakSet<object>();
const memoryPrototype = WebAssembly.Memory.prototype;
const descriptor = Object.getOwnPropertyDescriptor(memoryPrototype, "buffer");
const getBuffer = descriptor?.get;
if (!descriptor || !getBuffer) throw new Error("Missing WebAssembly memory buffer getter");
Object.defineProperty(memoryPrototype, "buffer", {
  ...descriptor,
  get() {
    const buffer: unknown = getBuffer.call(this);
    if (buffer !== null && typeof buffer === "object") memoryBuffers.add(buffer);
    return buffer;
  },
});

export function isWasmMemoryBuffer(value: unknown) {
  return value !== null && typeof value === "object" && memoryBuffers.has(value);
}

export function transferArrayBuffers(buffers: ArrayBuffer[]) {
  for (const buffer of buffers) {
    if (memoryBuffers.has(buffer)) throw new DOMException("WebAssembly memory is not transferable", "DataCloneError");
    new Uint8Array(buffer);
  }
  clone(undefined, { transfer: buffers });
}
