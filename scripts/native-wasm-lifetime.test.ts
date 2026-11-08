import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { installNativeWasmLifetime } from "../web/src/native-wasm-lifetime";
import { SLOT_NAMES } from "../web/src/net/trampoline";

const source = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");
const methods = ["compile", "compileStreaming", "instantiate", "instantiateStreaming"] as const;

function fixture(name: typeof methods[number]) {
  const gate = Promise.withResolvers<object>();
  const wasm = { [name]: () => gate.promise };
  const context = createContext({ WebAssembly: wasm, installNativeWasmLifetime, SLOT_NAMES, memoryViews: () => ({}), Promise, setTimeout, clearTimeout, queueMicrotask, TextEncoder, TextDecoder, URL });
  const Host = runInContext(source + "\nEngineHost;", context);
  const host = new Host({ instance: { exports: {} } }, () => {});
  host.internal = {};
  host.native = { hostCaps: {} };
  host.installGlobals();
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
