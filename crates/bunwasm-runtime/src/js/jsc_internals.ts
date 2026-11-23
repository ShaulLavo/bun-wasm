// Engine string-representation helpers for bun:internal-for-testing (`jscInternals`),
// matching Bun's src/jsc/bindings/JSCTestingHelpers.cpp (9510e74152073d850a18758ca41114d8f214ffa6).
// On JSC, delegates to native.stringIs8Bit (WTF::String::is8Bit) and throws
// TypeError("Expected a string") on non-string values. On engines that do not
// expose physical string storage, throws an explicit unsupported error instead
// of inferring storage width from character values.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;

  function checkWidth(value: unknown, wantUtf16: boolean): boolean {
    const is8Bit = native.stringIs8Bit?.(value);
    if (typeof is8Bit !== "boolean") {
      throw Object.assign(
        new Error(`jscInternals.${wantUtf16 ? "isUTF16String" : "isLatin1String"} is not supported on engine "${native.engine}"`),
        { code: "ERR_UNSUPPORTED" },
      );
    }
    return wantUtf16 ? !is8Bit : is8Bit;
  }

  return {
    isLatin1String(value: unknown): boolean {
      return checkWidth(value, false);
    },
    isUTF16String(value: unknown): boolean {
      return checkWidth(value, true);
    },
  };
});
