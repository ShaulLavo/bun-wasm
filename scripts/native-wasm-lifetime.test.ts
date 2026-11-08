import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { installNativeWasmLifetime } from "../web/src/native-wasm-lifetime";
import { observePromise } from "../web/src/promise-reactions";
import { SLOT_NAMES } from "../web/src/net/trampoline";

const source = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");
const methods = ["compile", "compileStreaming", "instantiate", "instantiateStreaming"] as const;

function fixture(name: typeof methods[number]) {
  const gate = Promise.withResolvers<object>();
  const wasm = { [name]: () => gate.promise };
  const context = createContext({ WebAssembly: wasm, installNativeWasmLifetime, observePromise, SLOT_NAMES, memoryViews: () => ({}), Promise, setTimeout, clearTimeout, queueMicrotask, TextEncoder, TextDecoder, URL });
  const Host = runInContext(source + "\nEngineHost;", context);
  const host = new Host({ instance: { exports: {} } }, () => {});
  host.internal = {};
  host.native = { hostCaps: {} };
  host.installGlobals();
  host.promiseThen = observePromise;
  return {
    host, gate,
    run(): Promise<unknown> { return runInContext(`WebAssembly.${name}()`, context); },
    close() { host.exited = true; gate.resolve({}); host.channel?.port1.close(); host.channel?.port2.close(); },
  };
}

function checkOperation(name: typeof methods[number], rejects: boolean): void {
  test(`native WebAssembly.${name} retains the host until ${rejects ? "rejection" : "fulfillment"}`, async () => {
    const state = fixture(name);
    try {
      const operation = state.run();
      expect(state.host.pendingAsync).toBe(1);
      const value = rejects ? new Error("native compilation failed") : {};
      const observed = operation.then(result => result, error => error);
      if (rejects) state.gate.reject(value);
      else state.gate.resolve(value);
      expect(await observed).toBe(value);
      await Promise.resolve();
      expect(state.host.pendingAsync).toBe(0);
    } finally { state.close(); }
  });
}

for (const name of methods) {
  checkOperation(name, false);
  checkOperation(name, true);
}

test("real native WebAssembly reactions ignore a throwing Promise species", () => {
  const result = spawnSync("node", ["--input-type=module", "-e", nativeSpeciesProbe], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

const nativeSpeciesProbe = `
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { spawnSync } from "node:child_process";
import { readFileSync } from 'node:fs';
import { installNativeWasmLifetime } from ${JSON.stringify(new URL("../web/src/native-wasm-lifetime.ts", import.meta.url).href)};
import { observePromise } from ${JSON.stringify(new URL("../web/src/promise-reactions.ts", import.meta.url).href)};
import { SLOT_NAMES } from ${JSON.stringify(new URL("../web/src/net/trampoline.ts", import.meta.url).href)};
const source = readFileSync(${JSON.stringify(new URL("../web/src/engine-host.js", import.meta.url).pathname)}, 'utf8')
  .replace(/^import .*;\\n/gm, '').replace('export function startEngineHost', 'function startEngineHost');
const context = createContext({ installNativeWasmLifetime, observePromise, SLOT_NAMES, memoryViews: () => ({}),
  setTimeout, clearTimeout, queueMicrotask, TextEncoder, TextDecoder, URL, Response });
const Host = runInContext(source + '\\nEngineHost;', context);
const host = new Host({ instance: { exports: {} } }, () => {});
host.internal = {};
host.native = { hostCaps: {} };
host.schedule = () => {};
host.installGlobals();
host.wrapPromiseJobs();
const operations = runInContext(\`
  const empty = new Uint8Array([0,97,115,109,1,0,0,0]);
  const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { throw new Error('species read'); } });
  try {
    [WebAssembly.compile(empty), WebAssembly.instantiate(empty),
     WebAssembly.compileStreaming(new Response(empty, { headers: { 'Content-Type': 'application/wasm' } })),
     WebAssembly.instantiateStreaming(new Response(empty, { headers: { 'Content-Type': 'application/wasm' } }))];
  } finally { Object.defineProperty(Promise, Symbol.species, original); }
\`, context);
assert.equal(host.pendingAsync, 4);
await Promise.all(operations);
assert.equal(host.pendingAsync, 0);
const sentinel = new Error('reaction attachment failed');
assert.throws(() => host.track(Promise.resolve(), () => { throw sentinel; }), error => error === sentinel);
assert.equal(host.pendingAsync, 0);
`;
