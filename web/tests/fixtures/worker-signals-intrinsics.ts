import { controlLoad, controlNotify, controlWait } from "waffle/proc/control";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { requestSignal, setSignalDisposition, takeSignal } from "waffle/proc/signals";

const context = self as unknown as DedicatedWorkerGlobalScope;
const post = context.postMessage.bind(context);
const nativeStore = Atomics.store;

context.onmessage = (event: MessageEvent<{ evidence: SharedArrayBuffer; gate: SharedArrayBuffer }>) => {
  const evidence = new Int32Array(event.data.evidence), gate = new Int32Array(event.data.gate);
  const state = workerProcessState(createWorkerProcessTransport());
  const methods = Object.getOwnPropertyDescriptors(Atomics);
  const prototype = Object.getPrototypeOf(Int32Array.prototype);
  const properties = ["buffer", "byteOffset", "byteLength", "length"] as const;
  const descriptors = properties.map(name => Object.getOwnPropertyDescriptor(prototype, name)!);
  let intercepted = 0;
  const replaced = () => { intercepted++; throw new Error("late guest replacement reached private process state"); };
  try {
    for (const name of ["load", "store", "add", "exchange", "compareExchange", "or", "notify", "wait"] as const) Atomics[name] = replaced;
    for (const name of properties) Object.defineProperty(prototype, name, { configurable: true, get: replaced });
    setSignalDisposition(state.signals.signalState, 2, 2);
    post({ phase: "waiting" });
    nativeStore(evidence, 0, 1);
    const waited = controlWait(gate, 0, 0, 2_000);
    const action = requestSignal(state.signals, 2).action;
    controlNotify(state.wake);
    const delivered = takeSignal(state.signals.signalState);
    const requested = controlLoad(state.signals.requestedSignal);
    post({ phase: "done", waited, action, delivered, requested, intercepted });
  } finally {
    Object.defineProperties(Atomics, methods);
    properties.forEach((name, index) => Object.defineProperty(prototype, name, descriptors[index]!));
  }
};
