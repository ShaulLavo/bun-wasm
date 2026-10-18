// Real native wait through Waffle's captured intrinsic. No WASM.
import { installAtomicsObservers, observedAtomics } from "./engine-interruption-atomics";
installAtomicsObservers();
const context = self as unknown as DedicatedWorkerGlobalScope;
context.onmessage = async (event: MessageEvent<{ evidence: SharedArrayBuffer; budget: SharedArrayBuffer }>) => {
  const { observeEventLoopWait } = await import("./engine-interruption-probe");
  const { controlWait } = await import("waffle/proc/control");
  const probe = new Int32Array(event.data.evidence), cells = new Int32Array(event.data.budget);
  const restore = observeEventLoopWait(probe, new Int32Array(event.data.budget, 4, 1), observedAtomics, 1_000);
  try { controlWait(cells, 1, 0, 4); }
  finally { restore(); }
};
