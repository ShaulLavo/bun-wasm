// Worker entry. Before it loads anything it posts one `worker-script` message: Waffle marks a
// process `worker-started` on its worker's first message, so a start that stalls after
// `start-posted` shows whether this script never ran or its imports never finished loading.
// Waffle's broker and Bun's runner ignore the message otherwise. The bootstrap is in worker-main.ts.
import type { RunRequest } from "./bun-executor.js";

export type { Engine, RunRequest, SleepMode, WorkerMessage } from "./bun-executor.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.postMessage({ type: "worker-script" });
// The broker sends one start message, possibly before worker-main.ts has loaded.
const early: MessageEvent<RunRequest>[] = [];
ctx.onmessage = (event: MessageEvent<RunRequest>) => { early.push(event); };
import("./worker-main.js").then(main => main.start(ctx, early), (error: unknown) => {
  // Rethrown outside the promise, a failed load reaches the page as the worker's error event.
  setTimeout(() => { throw error; });
});
