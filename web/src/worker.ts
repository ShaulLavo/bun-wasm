// Worker entry. Before it loads anything it posts one `worker-script` message: Waffle marks a
// process `worker-started` on its worker's first message, so a start that stalls after
// `start-posted` shows whether this script never ran or its imports never finished loading.
// Waffle's broker and Bun's runner ignore the message otherwise. The bootstrap is in worker-main.ts.
const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.postMessage({ type: "worker-script" });
// Messages that arrive while worker-main.ts loads (the broker's one start message) are kept and
// dispatched again once it has installed its handler.
const early: MessageEvent[] = [];
const keep = (event: MessageEvent) => { early.push(event); };
ctx.addEventListener("message", keep);
import("./worker-main.js").then(main => main.start(ctx, early, () => ctx.removeEventListener("message", keep)), (error: unknown) => {
  // Rethrown outside the promise, a failed load reaches the page as the worker's error event.
  setTimeout(() => { throw error; });
});

export type { Engine, RunRequest, SleepMode, WorkerMessage } from "./bun-executor.js";
