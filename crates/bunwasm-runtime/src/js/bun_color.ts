// Bun.color(input, format): JavaScript input handling from Bun's src/css_jsc/color_js.rs over
// Bun's CSS color parser in crates/bunwasm-build/src/color.rs (docs/bun-patches/bun-color.md).
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const FORMATS = ["[r,g,b,a]", "[rgb]", "[rgba]", "{r,g,b}", "{rgb}", "{rgba}", "ansi_256", "ansi-256", "ansi_16", "ansi-16",
    "ansi_16m", "ansi-16m", "ansi-24bit", "ansi-truecolor", "ansi", "ansi256", "css", "hex", "HEX", "hsl", "lab", "number", "rgb", "rgba"];
  const typeError = (message: string) => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });

  // color_int_from_js: a number, truncated to an integer and clamped to 0..255.
  function channel(value: unknown, property: string): number {
    if (typeof value !== "number") throw typeError(`Expected ${property} to be a integer for 'color'.`);
    return Math.min(255, Math.max(0, Math.trunc(value) | 0));
  }

  function fromNumber(value: number): number[] {
    // The low 32 bits; a 24-bit 0xRRGGBB number is opaque, wider values carry alpha on top.
    const int = Number(BigInt.asUintN(32, BigInt(Math.trunc(value) || 0)));
    return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff, int > 0xffffff ? (int >>> 24) & 0xff : 255];
  }

  function fromArray(value: ArrayLike<unknown>): number[] {
    if (value.length !== 3 && value.length !== 4) throw new Error("Expected array length 3 or 4");
    const out = Array.from({ length: value.length }, (_, index) => channel(value[index], `[${index}]`));
    return value.length === 3 ? out.concat([255]) : out;
  }

  function fromObject(value: Record<string, unknown>): number[] {
    const out = [channel(value.r, "r"), channel(value.g, "g"), channel(value.b, "b")];
    const alpha = value.a;
    return out.concat([alpha && typeof alpha === "number" ? Math.min(255, Math.max(0, Math.trunc(alpha * 255))) : 255]);
  }

  function rgba(input: unknown): number[] | undefined {
    if (typeof input === "number") return fromNumber(input);
    if (Array.isArray(input) || ArrayBuffer.isView(input)) return fromArray(input as ArrayLike<unknown>);
    if (input !== null && typeof input === "object") return fromObject(input as Record<string, unknown>);
    return undefined;
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
    return native.color(selected, native.utf8Encode(String(input)));
  };
})
