// Installs the guest realm's SharedArrayBuffer: a Proxy of the native constructor. Its construct
// trap follows the native argument order, then returns a pre-attached native fixed buffer when
// that exact fixed length has stock, so a blocked receiver can decode it without its event loop.
// No getter or prototype is altered: every buffer the guest holds is an ordinary native object.
import { nativeSharedConstructor } from "./native.ts";

export type ClaimFixedBuffer = (byteLength: number) => SharedArrayBuffer | null;
const maxIndex = 2 ** 53 - 1;
function toIndex(value: unknown) {
  const number = +(value as number); // ToNumber: throws for Symbol and BigInt.
  const integer = Number.isNaN(number) ? 0 : Math.trunc(number);
  if (integer < 0 || integer > maxIndex) throw new RangeError("Invalid array buffer length");
  return integer === 0 ? 0 : integer;
}
function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

export function installSharedBufferRealm(claim: ClaimFixedBuffer): void {
  const Native = nativeSharedConstructor();
  const intrinsic = Native.prototype;
  const Wrapper = new Proxy(Native, {
    construct(_target, args: unknown[], newTarget) {
      const byteLength = toIndex(args[0]);
      const options = args[1];
      const requested = isObject(options) ? (options as { maxByteLength?: unknown }).maxByteLength : undefined;
      const maxByteLength = requested === undefined ? undefined : toIndex(requested);
      if (maxByteLength !== undefined && byteLength > maxByteLength) throw new RangeError("Invalid array buffer max length");
      const candidate = (newTarget as { prototype?: unknown }).prototype;
      const prototype = isObject(candidate) ? candidate : intrinsic;
      const value = allocate(Native, claim, byteLength, maxByteLength);
      if (prototype !== intrinsic) Object.setPrototypeOf(value, prototype);
      return value;
    },
  });
  Object.defineProperty(intrinsic, "constructor", { value: Wrapper, writable: true, configurable: true });
  Object.defineProperty(globalThis, "SharedArrayBuffer", { value: Wrapper, writable: true, configurable: true, enumerable: false });
}

function allocate(Native: typeof SharedArrayBuffer, claim: ClaimFixedBuffer, byteLength: number, maxByteLength: number | undefined) {
  if (maxByteLength !== undefined) return new Native(byteLength, { maxByteLength });
  return claim(byteLength) ?? new Native(byteLength);
}
