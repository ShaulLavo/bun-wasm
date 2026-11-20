(function () {
  "use strict";

  return function fillArgs(validateEncoding: (encoding: unknown) => string, value: unknown, size: number, offset?: unknown, end?: unknown, encoding?: unknown) {
    if (typeof value !== "string")
      return offset === undefined ? { start: 0, stop: size } : { start: offset, stop: end };
    if (offset === undefined || typeof offset === "string")
      return { start: 0, stop: size, encoding: validateEncoding(offset) };
    if (typeof end === "string")
      return { start: offset, stop: size, encoding: validateEncoding(end) };
    return { start: offset, stop: end, encoding: validateEncoding(encoding) };
  };
});
