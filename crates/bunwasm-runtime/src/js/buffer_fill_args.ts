(function () {
  "use strict";

  return function fillArgs(value: unknown, size: number, offset?: number | string, end?: number | string, encoding?: string) {
    if (typeof offset === "string") return { start: 0, stop: size, encoding: offset };
    if (typeof value === "string" && typeof end === "string") return { start: offset, stop: size, encoding: end };
    return { start: offset, stop: end, encoding };
  };
});
