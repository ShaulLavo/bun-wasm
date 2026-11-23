// String and field helpers for the engine host's value encoding (engine-host.js Writer and
// Reader, mirrored by crates/bunwasm-runtime/src/engine_host.rs). Guest code runs in the same
// realm and may replace String, TextEncoder, TextDecoder or Object methods, so every built-in
// used here is captured when the worker bundle loads, before any guest code.

const apply = Reflect.apply;
const uncurryThis = <T, A extends unknown[], R>(method: (this: T, ...args: A) => R) =>
  (self: T, ...args: A): R => apply(method, self, args);
const defineProperty = Object.defineProperty;
const fromCharCode = String.fromCharCode;
const charCodeAt = uncurryThis(String.prototype.charCodeAt);
const stringSlice = uncurryThis(String.prototype.slice);
const bytesSlice = uncurryThis(Uint8Array.prototype.slice);
const bytesSubarray = uncurryThis(Uint8Array.prototype.subarray);
const encoder = new TextEncoder();
const encode = uncurryThis(TextEncoder.prototype.encode);
const encodeInto = uncurryThis(TextEncoder.prototype.encodeInto);
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const decode = uncurryThis(TextDecoder.prototype.decode);

// Most strings that cross are short ASCII paths and keys. Below these lengths a plain loop beats
// a TextEncoder or TextDecoder call, whose fixed cost is larger than the copy.
const SHORT_ENCODE = 16;
const SHORT_DECODE = 256;
/** Strings up to this many UTF-16 units are encoded in place (three bytes per unit fit). */
export const IN_PLACE_ENCODE = 1 << 16;

/** A string longer than IN_PLACE_ENCODE as a new UTF-8 array. */
export function encodeUtf8(text: string): Uint8Array {
  return encode(encoder, text);
}

/**
 * Writes `text` as UTF-8 into `target` at `at` and returns where it ended. The caller makes room
 * for three bytes per UTF-16 unit.
 */
export function encodeUtf8Into(text: string, target: Uint8Array, at: number): number {
  const length = text.length;
  let i = 0;
  if (length <= SHORT_ENCODE) i = copyAscii(text, target, at);
  if (i === length) return at + length;
  const rest = i === 0 ? text : stringSlice(text, i);
  return at + i + encodeInto(encoder, rest, bytesSubarray(target, at + i)).written;
}

/** Copies the leading ASCII of `text` to `at`; returns how many units it copied. */
function copyAscii(text: string, target: Uint8Array, at: number): number {
  for (let i = 0; i < text.length; i++) {
    const code = charCodeAt(text, i);
    if (code >= 0x80) return i;
    target[at + i] = code;
  }
  return text.length;
}

/** UTF-8 bytes `start` to `end` as a string, keeping a byte order mark. */
export function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  // Copied first: the decoder rejects views of shared memory, and wasm memory can grow.
  if (end - start > SHORT_DECODE || !ascii(bytes, start, end)) return decode(decoder, bytesSlice(bytes, start, end));
  if (end - start > SHORT_ENCODE) return apply(fromCharCode, undefined, bytesSubarray(bytes, start, end));
  let text = "";
  for (let i = start; i < end; i++) text += fromCharCode(bytes[i]!);
  return text;
}

function ascii(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (bytes[i]! >= 0x80) return false;
  }
  return true;
}

/** Defines `key` as an own enumerable data field: a "__proto__" key or an inherited setter must not intercept it. */
export function defineField(target: object, key: string, value: unknown): void {
  defineProperty(target, key, { __proto__: null, value, enumerable: true, writable: true, configurable: true } as PropertyDescriptor);
}
