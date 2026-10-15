(function (internal) {
  "use strict";
  const native = internal.native;
  const own = (o, k, fallback) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : fallback;

  function options(value) {
    if (value == null) value = {};
    if (typeof value === "string") value = { cwd: value };
    if (!value || typeof value !== "object") throw new TypeError("Expected options to be an object");
    const cwd = own(value, "cwd", process.cwd());
    if (typeof cwd !== "string" && !(cwd instanceof String)) throw new TypeError("Expected cwd to be a string");
    if (cwd.length > 4096) throw Object.assign(new Error("ENAMETOOLONG: name too long, scandir"), { code: "ENAMETOOLONG" });
    const flags = ["dot", "absolute", "followSymlinks", "throwErrorOnBrokenSymlink", "onlyFiles"];
    const defaults = [false, false, false, false, true];
    return [internal.require("path").resolve(String(cwd))].concat(flags.map((key, i) => {
      const flag = own(value, key, defaults[i]);
      return typeof flag === "boolean" ? flag : false;
    }));
  }

  class Glob {
    #pattern;
    constructor(pattern) {
      if (!arguments.length) throw new TypeError("Glob.constructor: expected 1 arguments, got 0");
      if (typeof pattern !== "string") throw new TypeError("Glob.constructor: first argument is not a string");
      this.#pattern = pattern;
    }
    match(path) {
      if (!arguments.length) throw new TypeError("Glob.matchString: expected 1 arguments, got 0");
      if (typeof path !== "string") throw new TypeError("Glob.matchString: first argument is not a string");
      return native.globMatch(this.#pattern, path);
    }
    scanSync(value) {
      const args = options(value);
      const pattern = this.#pattern;
      return (function* () { yield* native.globScan(pattern, ...args); })();
    }
    scan(value) {
      const args = options(value);
      const pattern = this.#pattern;
      return (async function* () { yield* native.globScan(pattern, ...args); })();
    }
  }
  Object.defineProperty(Glob.prototype, Symbol.toStringTag, { value: "Glob", configurable: true });
  return { Glob };
})
