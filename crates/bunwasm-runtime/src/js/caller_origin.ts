(function (internal: BunWasm.Internal) {
  "use strict";

  interface OriginSite {
    getFileName(): string | null;
    getLineNumber(): number | null;
    getColumnNumber(): number | null;
    isNative(): boolean;
    getScriptNameOrSourceURL?(): string | null;
    getEvalOrigin?(): string | null;
    isEval?(): boolean;
  }

  function originFile(file: string | null | undefined): string | null {
    if (!file) return null;
    if (file.startsWith("/")) return internal.pathToFileHref(file);
    return /^[a-z][a-z0-9+.-]*:/i.test(file) ? file : null;
  }

  function isOriginSite(value: unknown): value is OriginSite {
    return value !== null && typeof value === "object"
      && "getFileName" in value && typeof value.getFileName === "function"
      && "getLineNumber" in value && typeof value.getLineNumber === "function"
      && "getColumnNumber" in value && typeof value.getColumnNumber === "function"
      && "isNative" in value && typeof value.isNative === "function";
  }

  function evalFile(site: OriginSite): string | null {
    const origin = site.getEvalOrigin?.();
    return typeof origin === "string" ? /\(([^()]+):\d+:\d+\)/.exec(origin)?.[1] ?? null : null;
  }

  function structuredOrigin(_error: object, sites: unknown): string | null {
    if (!Array.isArray(sites)) return null;
    for (const site of sites) {
      if (!isOriginSite(site)) return null;
      if (site.isNative()) continue;
      const rawFile = site.getScriptNameOrSourceURL?.() || site.getFileName() || evalFile(site);
      if (!rawFile && !site.isEval?.()) continue;
      const file = internal.displayName ? internal.displayName(rawFile, site.isEval?.() ?? false) : rawFile;
      if (file?.startsWith("bun-wasm:")) continue;
      if (typeof site.getLineNumber() !== "number" || typeof site.getColumnNumber() !== "number") return null;
      return originFile(file);
    }
    return null;
  }

  function textOrigin(stack: string | undefined): string | null {
    const inspector = internal.require("inspect");
    for (const raw of String(stack || "").split("\n").slice(1)) {
      const line = raw.trim();
      if (!line || line === "Error") continue;
      const frame = inspector.parseStack(line)[0];
      if (frame) return originFile(frame.file);
      if (/^(?:at (?:.* \()?|[^@]*@)bun-wasm:/.test(line) || /\(native\)$|@\[native code\]$/.test(line)) continue;
      return null;
    }
    return null;
  }

  return function callerSourceOrigin(): string | null {
    const prepare = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = internal.hasNativeStackTrace ? structuredOrigin : internal.defaultPrepareStackTrace;
      const stack = new Error().stack;
      return internal.hasNativeStackTrace ? typeof stack === "string" ? stack : null : textOrigin(stack);
    } finally {
      Error.prepareStackTrace = prepare;
    }
  };
})
