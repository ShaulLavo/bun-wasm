// Captured while this bundle's module graph evaluates, before any guest realm installation.
// Absent on a page that is not cross-origin isolated; only actual shared allocation needs it.
const Native = globalThis.SharedArrayBuffer as typeof SharedArrayBuffer | undefined;
const prototype = Native?.prototype;
const lengthGetter = prototype && Object.getOwnPropertyDescriptor(prototype, "byteLength")!.get!;
const growableGetter = prototype && Object.getOwnPropertyDescriptor(prototype, "growable")!.get!;

export function nativeSharedConstructor(): typeof SharedArrayBuffer {
  if (!Native) throw new DOMException("Shared backing is unavailable", "DataCloneError");
  return Native;
}
export function createNativeSharedBuffer(byteLength: number): SharedArrayBuffer {
  return new (nativeSharedConstructor())(byteLength);
}
/** Throws for anything that is not a real SharedArrayBuffer. */
export function nativeSharedLength(value: unknown): number {
  if (!lengthGetter) throw new DOMException("Shared backing is unavailable", "DataCloneError");
  return lengthGetter.call(value);
}
export function nativeSharedFixed(value: unknown, byteLength: number): boolean {
  try { return nativeSharedLength(value) === byteLength && growableGetter!.call(value) === false; }
  catch { return false; }
}
