// Bun.color(input, format): JavaScript input handling from Bun's src/css_jsc/color_js.rs over
// Bun's CSS color parser in crates/bunwasm-build/src/color.rs (docs/bun-patches/bun-color.md).
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const FORMATS = ["[r,g,b,a]", "[rgb]", "[rgba]", "{r,g,b}", "{rgb}", "{rgba}", "ansi_256", "ansi-256", "ansi_16", "ansi-16",
    "ansi_16m", "ansi-16m", "ansi-24bit", "ansi-truecolor", "ansi", "ansi256", "css", "hex", "HEX", "hsl", "lab", "number", "rgb", "rgba"];
  const typeError = (message: string) => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });

  // Rust's saturating `f64 as` casts, which JSC's coerce::<i32> and to_int64 behave like here:
  // NaN is 0, and values past the range stick to its ends.
  function saturate(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) return 0;
    return Math.min(max, Math.max(min, Math.trunc(value)));
  }

  // color_int_from_js: a number, cast to i32, then clamped to 0..255.
  function channel(value: unknown, property: string): number {
    if (typeof value !== "number") throw typeError(`Expected ${property} to be a integer for 'color'.`);
    return Math.min(255, Math.max(0, saturate(value, -(2 ** 31), 2 ** 31 - 1)));
  }

  function fromNumber(value: number): number[] {
    // to_int64, then the low 32 bits; a 24-bit 0xRRGGBB number is opaque, wider values carry
    // alpha on top.
    const wide = Number.isNaN(value) ? 0n : value >= 2 ** 63 ? 2n ** 63n - 1n : value < -(2 ** 63) ? -(2n ** 63n) : BigInt(Math.trunc(value));
    const int = Number(BigInt.asUintN(32, wide));
    return [(int >>> 16) & 0xff, (int >>> 8) & 0xff, int & 0xff, int > 0xffffff ? (int >>> 24) & 0xff : 255];
  }

  // Intrinsic length getters, so an own `length` or `byteLength` cannot change what is read.
  const getter = (prototype: object, name: string) => Object.getOwnPropertyDescriptor(prototype, name)!.get as (this: unknown) => number;
  const typedLength = getter(Object.getPrototypeOf(Uint8Array.prototype), "length");
  const bufferLength = getter(ArrayBuffer.prototype, "byteLength");
  const sharedLength = typeof SharedArrayBuffer === "function" ? getter(SharedArrayBuffer.prototype, "byteLength") : undefined;

  // The getter's value if `value` has its brand.
  function branded(read: ((this: unknown) => number) | undefined, value: object): number | undefined {
    if (!read) return undefined;
    try {
      return read.call(value);
    } catch {
      return undefined;
    }
  }

  // JSC's is_array_like, read once: typed arrays by their length, array buffers by their byte
  // length, and arrays (not proxies around them). DataViews and other objects are not array-like.
  function arrayLikeLength(value: object): number | undefined {
    if (ArrayBuffer.isView(value)) return branded(typedLength, value);
    const bytes = branded(bufferLength, value) ?? branded(sharedLength, value);
    if (bytes !== undefined) return bytes;
    // The browser engine cannot tell a proxy from JavaScript (its isProxy is always false).
    if (Array.isArray(value) && !native.isProxy?.(value)) return value.length;
    return undefined;
  }

  // Elements are read from the object itself, so an ArrayBuffer's own index properties count.
  function fromArray(value: Record<number, unknown>, length: number): number[] {
    if (length !== 3 && length !== 4) throw new Error("Expected array length 3 or 4");
    const out = Array.from({ length }, (_, index) => channel(value[index], `[${index}]`));
    return length === 3 ? out.concat([255]) : out;
  }

  // Alpha is a 0..1 number (get_truthy keeps 0 and NaN); anything else, or none, is opaque.
  function fromObject(value: Record<string, unknown>): number[] {
    const out = [channel(value.r, "r"), channel(value.g, "g"), channel(value.b, "b")];
    const alpha = value.a;
    return out.concat([typeof alpha === "number" ? Math.min(255, Math.max(0, saturate(alpha * 255, -(2 ** 63), 2 ** 63))) : 255]);
  }

  // js_function_color's dispatch: numbers, array-likes, then any object (functions too).
  function rgba(input: unknown): number[] | undefined {
    if (typeof input === "number") return fromNumber(input);
    if (input === null || (typeof input !== "object" && typeof input !== "function")) return undefined;
    const length = arrayLikeLength(input);
    return length === undefined ? fromObject(input as Record<string, unknown>) : fromArray(input as Record<number, unknown>, length);
  }

  return function color(input: unknown, format?: unknown) {
    if (input === undefined) throw typeError("Expected input to be a string, number, or object for 'color'.");
    let selected = "css";
    if (format !== undefined && format !== null) {
      if (typeof format !== "string") throw typeError("Expected format to be a string for 'color'.");
      if (!FORMATS.includes(format)) {
        throw typeError(`format must be one of '${FORMATS.slice(0, -1).join("', '")}' or '${FORMATS[FORMATS.length - 1]}'`);
      }
      selected = format;
    }
    const channels = rgba(input);
    if (channels) return native.color(selected, undefined, channels[0], channels[1], channels[2], channels[3]);
    if (typeof input === "symbol") throw new TypeError("Cannot convert a symbol to a string");
    return native.color(selected, native.utf8Encode(String(input)));
  };
})
