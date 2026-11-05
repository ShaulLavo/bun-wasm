import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Sources for running engine-host.js's async-context hooks inside a node:vm context:
// its own module text without imports, and bootstrap.js's runInContext.

export function engineHostSource(): string {
  return readFileSync(new URL("../../src/engine-host.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export function startEngineHost", "function startEngineHost");
}

export function runInContextSource(): string {
  const bootstrap = readFileSync(new URL("../../../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const start = bootstrap.indexOf("  function runInContext(context, fn, thisArg, args) {");
  const end = bootstrap.indexOf("  internal.runInContext = runInContext;", start);
  assert(start >= 0 && end > start);
  return `${bootstrap.slice(start, end)}\n  internal.runInContext = runInContext;\n`;
}

export function builtinsSource(): string {
  return readFileSync(new URL("../../../crates/bunwasm-runtime/src/js/builtins.js", import.meta.url), "utf8") + "(internal);";
}
