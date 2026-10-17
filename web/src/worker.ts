// Worker entry: Waffle's process bootstrap running Bun's executor (bun-executor.ts).
import { bootstrap } from "waffle/browser/worker";
import { createBunExecutor, type RunRequest } from "./bun-executor.js";

export type { Engine, RunRequest, SleepMode, WorkerMessage } from "./bun-executor.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (event: MessageEvent<RunRequest>) => bootstrap(event.data, createBunExecutor(event.data, ctx), ctx);
