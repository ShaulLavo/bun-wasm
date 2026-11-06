import { bootstrap, preview1Executor, type RuntimeWorkerRequest } from "waffle/browser/worker";

// Noninteractive tools keep Waffle's plain executor and never load terminal code.
globalThis.onmessage = async (event: MessageEvent<RuntimeWorkerRequest>) => {
  const request = event.data;
  const data = request.runtimeProcess?.data;
  const interactive = data && typeof data === "object" && ("terminalContext" in data || "terminalInput" in data);
  const executor = interactive
    ? (await import("./preview1-executor")).terminalPreview1Executor(request)
    : preview1Executor;
  await bootstrap(request, executor);
};
