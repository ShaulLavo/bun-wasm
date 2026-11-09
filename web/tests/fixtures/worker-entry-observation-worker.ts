import type { RunRequest } from "../../src/bun-executor.ts";

const host = self as unknown as DedicatedWorkerGlobalScope & { bunImportGate: Int32Array };
Object.defineProperty(host, "location", { configurable: true, value: { href: import.meta.url } });
Object.defineProperty(host, "crossOriginIsolated", { configurable: true, value: true });
host.onmessage = async (event: MessageEvent<{ entry: string; request: RunRequest; gate: SharedArrayBuffer }>) => {
  const { entry, request, gate } = event.data;
  host.bunImportGate = new Int32Array(gate);
  await import(entry);
  const execute = host.onmessage;
  if (!execute) throw new Error("Bun worker entry did not install its bootstrap handler");
  const environment = request.env;
  Object.defineProperty(request, "env", { get() {
    host.postMessage({ type: "executor-environment" });
    return environment;
  } });
  await execute.call(host, new MessageEvent("message", { data: request }));
  host.postMessage({ type: "entry-finished" });
};
