(function () {
  "use strict";

  return function fillArgs(validateEncoding: (encoding: string) => string, value: unknown, size: number, offset?: number | string, end?: number | string, encoding?: string) {
    if (typeof value === "string" && offset === undefined) return { start: 0, stop: size, encoding: "utf8" };
    if (typeof offset === "string") return { start: 0, stop: size, encoding: offset };
    if (typeof value === "string" && typeof offset === "number" && typeof end === "string")
      return { start: offset, stop: size, encoding: validateEncoding(end) };
    return { start: offset, stop: end, encoding };
  };
});
