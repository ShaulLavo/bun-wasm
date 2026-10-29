import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { MessageHandler, instantiateNapiModuleSync } from "@emnapi/core";
import { WASI } from "node:wasi";

assert.ok(parentPort);
const port = parentPort;
const data: unknown = workerData;
if (!data || typeof data !== "object" || !("module" in data) || !(data.module instanceof WebAssembly.Module)
  || !("memory" in data) || !(data.memory instanceof WebAssembly.Memory) || !("role" in data)
  || !("alias" in data) || !("moduleAlias" in data)) throw new Error("Invalid Wasm worker data");
const { module, memory, role, alias, moduleAlias } = data;
assert.equal(memory, alias);
assert.equal(module, moduleAlias);
const instance = new WebAssembly.Instance(module, { env: { memory } });
const view = new Int32Array(memory.buffer);
const wait = instance.exports.wait;
const notify = instance.exports.notify;
assert.equal(typeof wait, "function");
assert.equal(typeof notify, "function");
if (typeof wait !== "function" || typeof notify !== "function") throw new Error("Missing atomics exports");
if (role === "waiter") {
  Atomics.store(view, 1, 42);
  port.postMessage("waiting");
  assert.equal(wait(0, 5_000_000_000n), 0);
  assert.equal(Atomics.load(view, 2), 73);
  Atomics.store(view, 0, 7);
  assert.equal(wait(0, 0n), 1);
  assert.equal(wait(7, 0n), 2);
  port.postMessage("wait-ok");
}
const handler = new MessageHandler({
  postMessage(message) { port.postMessage(message); },
  onLoad({ wasmModule, wasmMemory }) {
    assert.ok(wasmModule instanceof WebAssembly.Module);
    assert.ok(wasmMemory instanceof WebAssembly.Memory);
    const shared = new Int32Array(wasmMemory.buffer);
    assert.equal(Atomics.load(shared, 0), 7);
    Atomics.store(shared, 5, 99);
    return instantiateNapiModuleSync(wasmModule, {
      childThread: true,
      wasi: new WASI({ version: "preview1", args: [], env: {}, preopens: {} }),
      overwriteImports(imports) { return { ...imports, env: { ...imports.env, memory: wasmMemory } }; },
    });
  },
});
port.on("message", message => {
  if (message === "notify") {
    Atomics.store(view, 2, 73);
    const deadline = Date.now() + 5000;
    while (!notify()) {
      assert.ok(Date.now() < deadline, "waiter must park");
      Atomics.wait(view, 3, 0, 1);
    }
    port.postMessage("notify-ok"); return;
  }
  if (message === "check") {
    assert.equal(Atomics.load(view, 0), 7);
    port.postMessage("alias-ok"); return;
  }
  handler.handle({ data: message });
});
port.postMessage("ready");
