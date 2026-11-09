import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { NodeProcessBroker } from "../../scripts/node-spawn.ts";
import { createNodeSignalController } from "../../scripts/node-signals.ts";
import { workerProcessState } from "waffle/proc/worker-client";
import { captureProcessObserver } from "waffle/proc/observation";

let broker: NodeProcessBroker | undefined;
let worker: Worker | undefined;
const gate = new Int32Array(new SharedArrayBuffer(4));
try {
  broker = new NodeProcessBroker({ module: new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])), launch() { throw new Error("No child in natural root control"); } });
  const observer = captureProcessObserver(broker.root);
  const signals = createNodeSignalController(workerProcessState(broker.root).signals);
  worker = new Worker(new URL("./node-observation-worker.ts", import.meta.url));
  broker.attach(worker, broker.root);
  const ready = once(worker, "message");
  const exit = once(worker, "exit");
  const selected = Promise.withResolvers<ReturnType<typeof signals.finish>>();
  worker.on("exit", code => {
    try { selected.resolve(signals.finish(code)); }
    catch (error) { selected.reject(error); }
  });
  worker.postMessage({ transport: broker.root, gate: gate.buffer });
  await ready;
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  await exit;
  assert.deepEqual(await selected.promise, { kind: "exited", code: 0, status: 0 });
  assert.deepEqual(observer.read(), { kind: "terminated" });
  await broker.dispose();
  console.log("PASS Node natural root observation");
} finally {
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  await worker?.terminate();
  await broker?.dispose();
}
