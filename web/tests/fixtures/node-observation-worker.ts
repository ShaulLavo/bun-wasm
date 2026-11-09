import { parentPort } from "node:worker_threads";
import { captureProcessObserver } from "waffle/proc/observation";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

parentPort!.once("message", (request: { transport: WorkerProcessTransport; gate: SharedArrayBuffer }) => {
  const observer = captureProcessObserver(request.transport);
  const gate = new Int32Array(request.gate);
  parentPort!.postMessage({ type: "ready" });
  Atomics.wait(gate, 0, 0);
  parentPort!.postMessage({ type: "observed", observation: observer.read() });
});
