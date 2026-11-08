import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SLOT_NAMES } from "../web/src/net/trampoline";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");

for (const name of ["compile", "compileStreaming", "instantiate", "instantiateStreaming"] as const) {
  test(`native WebAssembly.${name} keeps the browser host alive until settlement`, async () => {
    const gate = Promise.withResolvers<object>();
    const wasm = { [name]: () => gate.promise };
    const context = createContext({ WebAssembly: wasm, SLOT_NAMES, memoryViews: () => ({}), Promise, setTimeout, clearTimeout, queueMicrotask, TextEncoder, TextDecoder, URL });
    const Host = runInContext(source + "\nEngineHost;", context);
    const host = new Host({ instance: { exports: {} } }, () => {});
    host.internal = {};
    host.native = { hostCaps: {} };
    host.installGlobals();
    const operation: Promise<unknown> = wasm[name]();
    expect(host.pendingAsync).toBe(1);
    const value = {};
    gate.resolve(value);
    expect(await operation).toBe(value);
    await Promise.resolve();
    expect(host.pendingAsync).toBe(0);
    host.exited = true;
    host.channel?.port1.close();
    host.channel?.port2.close();
  });
}
