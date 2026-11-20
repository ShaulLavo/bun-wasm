// process.allowedNodeEnvironmentFlags, adapted from Bun's buildAllowedNodeEnvironmentFlags
// (src/js/builtins/ProcessObjectInternals.ts), a port of Node's buildAllowedFlags
// (lib/internal/process/per_thread.js): a frozen Set whose has() normalizes "_" to "-",
// missing dashes and "=value" suffixes, and whose mutators do nothing.
(function () {
  "use strict";
  const canonical = [
    "--conditions", "--diagnostic-dir", "--disable-warning", "--dns-result-order", "--enable-source-maps", "--import",
    "--inspect", "--inspect-brk", "--inspect-port", "--max-http-header-size", "--no-addons", "--no-deprecation",
    "--no-warnings", "--pending-deprecation", "--perf-basic-prof", "--perf-basic-prof-only-functions", "--perf-prof",
    "--perf-prof-unwinding-info", "--preserve-symlinks", "--preserve-symlinks-main", "--redirect-warnings", "--require",
    "-r", "--stack-trace-limit", "--throw-deprecation", "--title", "--trace-deprecation", "--trace-warnings",
    "--use-bundled-ca", "--use-openssl-ca", "--use-system-ca", "--zero-fill-buffers",
  ];
  const canonicalSet = new Set(canonical);

  class NodeEnvironmentFlagsSet extends Set<string> {
    add() {
      return this;
    }
    delete() {
      return false;
    }
    clear() {}
    has(key: unknown) {
      if (typeof key !== "string") return false;
      key = key.replaceAll("_", "-");
      const flag = key as string;
      if (/^--?[^-]/.test(flag)) return canonicalSet.has(flag.replace(/=.*$/, ""));
      if (flag.startsWith("-")) return false;
      return canonicalSet.has(`--${flag}`) || canonicalSet.has(`-${flag}`);
    }
    forEach(callback: (value: string, key: string, set: Set<string>) => void, thisArg?: unknown) {
      for (const flag of canonical) callback.call(thisArg, flag, flag, this);
    }
    get size() {
      return canonicalSet.size;
    }
    *[Symbol.iterator](): SetIterator<string> {
      yield* canonical;
    }
    *values(): SetIterator<string> {
      yield* canonical;
    }
    *keys(): SetIterator<string> {
      yield* canonical;
    }
    *entries(): SetIterator<[string, string]> {
      for (const flag of canonical) yield [flag, flag];
    }
  }

  Object.freeze(NodeEnvironmentFlagsSet.prototype.constructor);
  Object.freeze(NodeEnvironmentFlagsSet.prototype);
  return Object.freeze(new NodeEnvironmentFlagsSet());
})
