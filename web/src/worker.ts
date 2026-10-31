// Worker entry: Waffle's process bootstrap running Bun's executor (bun-executor.ts).
import { bootstrap } from "waffle/browser/worker";
import { createBunExecutor, hasTerminalMetadata, type RunRequest, type TerminalModule } from "./bun-executor.js";

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
// Like Waffle's own terminal module, Bun's loads only for a process the shell gave a terminal session.
// The broker sends one start message, so awaiting it before bootstrap loses nothing.
const terminalModule = (request: RunRequest): Promise<TerminalModule> => hasTerminalMetadata(request)
  ? import("./bun-terminal.js").catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
  : Promise.resolve(undefined);
ctx.onmessage = async (event: MessageEvent<RunRequest>) => {
  const request = event.data;
  await bootstrap(request, createBunExecutor(request, host, await terminalModule(request)), host);
};
