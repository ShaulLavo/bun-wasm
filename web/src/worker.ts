// Worker entry. Before it loads anything it posts one `worker-script` message: Waffle marks a
// process `worker-started` on its worker's first message, so a start that stalls after
// `start-posted` shows whether this script never ran or its imports never finished loading.
// Waffle's broker and Bun's runner ignore the message otherwise. The bootstrap is in worker-main.ts.
import { earlyInstance, type EarlyInstance } from "./early-instance.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.postMessage({ type: "worker-script" });
// The bootstrap loads once the first message has arrived, so the guest is instantiated on the
// start message while this worker's heap is still almost empty (early-instance.ts). The broker
// posts that message right after it creates the worker, so nothing waits. Messages that arrive
// while worker-main.ts loads are kept and dispatched again once it has installed its handler.
const early: MessageEvent[] = [];
let instance: EarlyInstance | undefined;
let loading = false;
const keep = (event: MessageEvent) => {
  early.push(event);
  instance ??= earlyInstance(event.data);
  if (loading) return;
  loading = true;
  import("./worker-main.js").then(main => main.start(ctx, early, () => ctx.removeEventListener("message", keep), instance), (error: unknown) => {
    // Rethrown outside the promise, a failed load reaches the page as the worker's error event.
    setTimeout(() => { throw error; });
  });
};
ctx.addEventListener("message", keep);

export type { Engine, RunRequest, SleepMode, WorkerMessage } from "./bun-executor.js";
