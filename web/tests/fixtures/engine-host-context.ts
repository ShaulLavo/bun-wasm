import { installNativeWasmLifetime } from "../../src/native-wasm-lifetime.ts";
import { createTickScheduler } from "../../src/tick-scheduler.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Sources for running engine-host.js's async-context hooks inside a node:vm context:
// its own module text without imports, and bootstrap.js's runInContext.

export function engineHostSource(): string {
  const host = readFileSync(new URL("../../src/engine-host.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export function startEngineHost", "function startEngineHost");
  return installNativeWasmLifetime.toString().concat("\n", createTickScheduler.toString(), "\n", host);
}

export function runInContextSource(): string {
  const bootstrap = readFileSync(new URL("../../../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const start = bootstrap.indexOf("  function runInContext(context, fn, thisArg, args) {");
  const end = bootstrap.indexOf("  internal.runInContext = runInContext;", start);
  assert(start >= 0 && end > start);
  return `${bootstrap.slice(start, end)}\n  internal.runInContext = runInContext;\n`;
}

// builtins.js, run on `internal`, with the AsyncLocalStorage module node:async_hooks requires
// served over whatever stub require the harness gave it.
export function builtinsSource(): string {
  const js = new URL("../../../crates/bunwasm-runtime/src/js/", import.meta.url);
  const storage = stripTypeScriptTypes(readFileSync(new URL("async_local_storage.ts", js), "utf8"));
  const builtins = readFileSync(new URL("builtins.js", js), "utf8");
  return `{
    const asyncLocalStorage = ${storage}
    const stubRequire = internal.require;
    let loaded;
    internal.require = name => name === "async_local_storage" ? (loaded ??= asyncLocalStorage(internal)) : stubRequire(name);
  }
  ${builtins}(internal);`;
}
