// Test bootstrap only: run the unmodified production worker with observed imports.
import type { RunRequest } from "../src/worker";
import { observeEngineImports, observeEventLoopWait, observedEngineStart, probeCell, type EngineInterruptionOptions } from "./engine-interruption-probe";

const context = self as unknown as DedicatedWorkerGlobalScope;
context.onmessage = async (event: MessageEvent<RunRequest & { engineInterruption: EngineInterruptionOptions }>) => {
  const options = event.data.engineInterruption;
  const probe = new Int32Array(options.evidence);
  const signal = event.data.child?.requestedSignal ?? event.data.requestedSignal;
  const signalState = event.data.child?.signalState ?? event.data.signalState;
  if (!signal || !signalState) throw new Error("interruption probe requires the production signal transport");
  const NativeInstance = WebAssembly.Instance;
  const Instance = new Proxy(NativeInstance, {
    construct(Target, args: ConstructorParameters<typeof WebAssembly.Instance>) {
      if (args[0] !== event.data.module) return new Target(...args);
      const imports = args[1];
      if (!imports) throw new Error("interruption probe requires the production imports");
      let instance: WebAssembly.Instance;
      observeEngineImports(imports, probe, () => instance.exports.memory as WebAssembly.Memory, new Int32Array(signal), new Int32Array(signalState), options.observeCheckpoints);
      instance = new Target(...args);
      const exports = { ...instance.exports, _start: observedEngineStart(instance.exports, probe, options.hooks) };
      // Wasm exports are non-configurable; a proxy of the exports object itself cannot
      // replace _start. Proxy the instance and return an ordinary exports snapshot.
      return new Proxy(instance, { get(target, name) { return name === "exports" ? exports : Reflect.get(target, name, target); } });
    },
  });
  WebAssembly.Instance = Instance;
  const restoreWait = options.observeCheckpoints && event.data.child
    ? observeEventLoopWait(probe, event.data.child.budget, Atomics, options.idleWaitTimeoutMs) : () => {};
  try {
    await import("../src/worker");
    const run = context.onmessage;
    if (!run) throw new Error("production worker did not install its entry point");
    await run.call(context, event);
    // Unlike a logical process exit, this cannot happen while _start is still spinning.
    Atomics.store(probe, probeCell.runReturned, 1);
  } finally { restoreWait(); WebAssembly.Instance = NativeInstance; }
};
