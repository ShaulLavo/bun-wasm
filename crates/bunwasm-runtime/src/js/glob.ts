(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const own = (o: Record<string, unknown>, k: string, fallback: unknown) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : fallback;

  function options(value: Record<string, unknown> | string | null | undefined): BunWasm.GlobScanOptions {
    if (value == null) value = {};
    if (typeof value === "string") value = { cwd: value };
    if (!value || typeof value !== "object") throw new TypeError("Expected options to be an object");
    const cwd = own(value, "cwd", process.cwd());
    if (typeof cwd !== "string" && !(cwd instanceof String)) throw new TypeError("Expected cwd to be a string");
    if (cwd.length > 4096) throw Object.assign(new Error("ENAMETOOLONG: name too long, scandir"), { code: "ENAMETOOLONG" });
    const flag = (key: string, fallback = false) => {
      const result = own(value, key, fallback);
      return typeof result === "boolean" ? result : false;
    };
    return [internal.require("path").resolve(String(cwd)), flag("dot"), flag("absolute"),
      flag("followSymlinks"), flag("throwErrorOnBrokenSymlink"), flag("onlyFiles", true)];
  }

  class Glob {
    #pattern: string;
    constructor(pattern: string) {
      if (!arguments.length) throw new TypeError("Glob.constructor: expected 1 arguments, got 0");
      if (typeof pattern !== "string") throw new TypeError("Glob.constructor: first argument is not a string");
      this.#pattern = pattern;
    }
    match(path: string) {
      if (!arguments.length) throw new TypeError("Glob.matchString: expected 1 arguments, got 0");
      if (typeof path !== "string") throw new TypeError("Glob.matchString: first argument is not a string");
      return native.globMatch(this.#pattern, path);
    }
    scanSync(value?: Record<string, unknown> | string | null) {
      const args = options(value);
      const pattern = this.#pattern;
      return (function* () { yield* native.globScan(pattern, ...args); })();
    }
    scan(value?: Record<string, unknown> | string | null) {
      const args = options(value);
      const pattern = this.#pattern;
      return (async function* () { yield* native.globScan(pattern, ...args); })();
    }
  }
  Object.defineProperty(Glob.prototype, Symbol.toStringTag, { value: "Glob", configurable: true });
  return { Glob };
})
