// Worker entry: Waffle's process bootstrap running Bun's executor (bun-executor.ts).
import { bootstrap } from "waffle/browser/worker";
import { createBunExecutor, type RunRequest } from "./bun-executor.js";

export type { Engine, RunRequest, SleepMode, WorkerMessage } from "./bun-executor.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
// Keep the process transport on host-owned callables. Bun's browser guest runs in this same
// worker realm and may replace global methods while evaluating user code; passing `ctx` directly
// would let that code forge or suppress lifecycle messages after bootstrap starts.
const host = Object.freeze({
  crossOriginIsolated: ctx.crossOriginIsolated,
  location: { href: ctx.location.href },
  fetch: ctx.fetch.bind(ctx),
  postMessage: ctx.postMessage.bind(ctx),
  addEventListener: ctx.addEventListener.bind(ctx),
  removeEventListener: ctx.removeEventListener.bind(ctx),
});
ctx.onmessage = (event: MessageEvent<RunRequest>) => bootstrap(event.data, createBunExecutor(event.data, host), host);
