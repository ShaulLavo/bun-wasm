// process.versions names the engine that is actually running, under the key native Bun
// uses for it, and no other engine. The engine is fingerprinted from its own Error objects.
const ENGINE_KEYS = ["quickjs", "webkit", "spidermonkey", "hermes", "v8"];

function runningEngine(): string {
  const own = Object.getOwnPropertyNames(new Error("probe"));
  if (typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === "object") return "hermes";
  if (own.includes("sourceURL")) return "webkit";
  if (own.includes("lineNumber")) return "spidermonkey";
  // Of the remaining engines, only V8 keeps its CallSite API natively on Error.
  if (Function.prototype.toString.call(Error.captureStackTrace).includes("[native code]")) return "v8";
  return "quickjs";
}

const versions = process.versions as Record<string, string | undefined>;
const engine = runningEngine();
const reported = ENGINE_KEYS.filter((key) => versions[key] !== undefined);
// Native Bun runs on JSC and also reports a Node-compatible `v8` string; nothing else may
// name a second engine.
const allowed = engine === "webkit" && !versions.wasi ? ["webkit", "v8"] : [engine];
const version = versions[engine] ?? "";

console.log("names the running engine:", typeof versions[engine] === "string");
console.log("names no other engine:", reported.every((key) => allowed.includes(key)));
console.log("real version:", /^[0-9a-f]{40}$|^\d+\.\d+(\.\d+)?/.test(version) && version !== "ng");
console.log("node, bun:", typeof versions.node, typeof versions.bun);
