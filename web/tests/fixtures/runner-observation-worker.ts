import { captureProcessObserver } from "waffle/proc/observation";
import type { RunRequest } from "../../src/bun-executor.ts";

const host = self as unknown as DedicatedWorkerGlobalScope;
host.onmessage = (event: MessageEvent<RunRequest & { gate: SharedArrayBuffer }>) => {
  const request = event.data;
  if (!request.runtimeProcess) throw new Error("CPU root needs its canonical transport");
  const observer = captureProcessObserver(request.runtimeProcess);
  const gate = new Int32Array(request.gate);
  host.postMessage({ type: "cpu-ready", observation: observer.read() });
  host.postMessage({ type: "exit", code: 0 });
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  Atomics.wait(gate, 1, 0);
  host.postMessage({ type: "cpu-observed", observation: observer.read() });
};
