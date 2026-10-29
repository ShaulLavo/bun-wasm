import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { atomicModuleBytes } from "./atomic-module.ts";

const module = new WebAssembly.Module(atomicModuleBytes);
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const input = { module, memory, alias: memory, moduleAlias: module, view: new Int32Array(memory.buffer) };
const workers = ["waiter", "notifier"].map(role => new Worker(new URL("./worker.ts", import.meta.url), { workerData: { ...input, role } }));
const [waiter, notifier] = workers;
assert.ok(waiter && notifier);
const pending = new Map<string, () => void>();
const seen = new Set<string>();
function expect(key: string) {
  if (seen.has(key)) return Promise.resolve();
  return new Promise<void>(resolve => pending.set(key, resolve));
}
function receive(role: number, message: unknown) {
  const key = typeof message === "string" ? `${role}/${message}` : `${role}/${JSON.stringify(message)}`;
  seen.add(key); pending.get(key)?.(); pending.delete(key);
}
for (const [role, worker] of workers.entries()) {
  worker.on("message", message => receive(role, message));
  worker.on("error", error => { console.error(error); process.exit(1); });
}
try {
  await Promise.all([expect("0/waiting"), expect("1/ready")]);
  notifier.postMessage("notify");
  await Promise.all([expect("0/wait-ok"), expect("1/notify-ok")]);
  notifier.postMessage("check");
  await expect("1/alias-ok");
  assert.equal(Atomics.load(new Int32Array(memory.buffer), 1), 42);
  assert.equal(Atomics.load(new Int32Array(memory.buffer), 2), 73);
  const loaded = '1/{"__emnapi__":{"type":"loaded","payload":{}}}';
  notifier.postMessage({ __emnapi__: { type: "load", payload: { wasmModule: module, wasmMemory: memory } } });
  await expect(loaded);
  notifier.postMessage({ __emnapi__: { type: "start", payload: { tid: 19, arg: 23 } } });
  await expect('1/{"__emnapi__":{"type":"cleanup-thread","payload":{"tid":19}}}');
  const view = new Int32Array(memory.buffer);
  assert.equal(Atomics.load(view, 3), 19);
  assert.equal(Atomics.load(view, 4), 23);
  assert.equal(Atomics.load(view, 5), 99);
  assert.equal(memory.buffer.byteLength, 65536);
  console.log("wasm-transfer-ok wait=ok/not-equal/timed-out notify=1 aliases=both-directions emnapi=loaded/started bytes=65536");
} finally { await Promise.all(workers.map(worker => worker.terminate())); }
