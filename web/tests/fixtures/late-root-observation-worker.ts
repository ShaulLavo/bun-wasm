import { captureProcessObserver } from "waffle/proc/observation";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

const host = self as unknown as DedicatedWorkerGlobalScope;
host.onmessage = (event: MessageEvent<{ transport: WorkerProcessTransport; gate: SharedArrayBuffer }>) => {
  const observer = captureProcessObserver(event.data.transport);
  const gate = new Int32Array(event.data.gate);
  host.postMessage({ type: "cpu-ready", observation: observer.read() });
  Atomics.wait(gate, 0, 0);
  host.postMessage({ type: "cpu-observed", observation: observer.read() });
};
