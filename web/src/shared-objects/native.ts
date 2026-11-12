// Captured before guest realm installation, including hosts without growable shared buffers.
const Native = globalThis.SharedArrayBuffer as typeof SharedArrayBuffer | undefined;
const prototype = Native?.prototype;
const lengthGetter = prototype && Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
const growableGetter = prototype && Object.getOwnPropertyDescriptor(prototype, "growable")?.get;
const maximumGetter = prototype && Object.getOwnPropertyDescriptor(prototype, "maxByteLength")?.get;
const grow = prototype?.grow;

export function nativeSharedConstructor(): typeof SharedArrayBuffer {
  if (!Native) throw new DOMException("Shared backing is unavailable", "DataCloneError");
  return Native;
}
export function createNativeSharedBuffer(byteLength: number): SharedArrayBuffer {
  return new (nativeSharedConstructor())(byteLength);
}
export function createNativeGrowableBuffer(maxByteLength: number): SharedArrayBuffer {
  if (!growableGetter || !maximumGetter || !grow) throw new DOMException("Growable shared backing is unavailable", "DataCloneError");
  const buffer = new (nativeSharedConstructor())(0, { maxByteLength });
  if (!nativeSharedGrowable(buffer, maxByteLength)) throw new DOMException("Growable shared backing is unavailable", "DataCloneError");
  return buffer;
}
export function nativeSharedGrow(buffer: SharedArrayBuffer, byteLength: number): void {
  if (!grow) throw new DOMException("Growable shared backing is unavailable", "DataCloneError");
  grow.call(buffer, byteLength);
}
/** Throws for anything that is not a real SharedArrayBuffer. */
export function nativeSharedLength(value: unknown): number {
  if (!lengthGetter) throw new DOMException("Shared backing is unavailable", "DataCloneError");
  return lengthGetter.call(value);
}
export function nativeSharedFixed(value: unknown, byteLength: number): boolean {
  try { return nativeSharedLength(value) === byteLength && (!growableGetter || growableGetter.call(value) === false); }
  catch { return false; }
}
export function nativeSharedGrowable(value: unknown, maximum: number): value is SharedArrayBuffer {
  try { return nativeSharedLength(value) <= maximum && growableGetter?.call(value) === true && maximumGetter?.call(value) === maximum; }
  catch { return false; }
}
