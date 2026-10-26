import { bootstrap } from "waffle/browser/worker";
import { createFilesystemConnection } from "waffle/fs";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { createBunExecutor, type RunRequest, type WorkerMessage } from "../../../web/src/bun-executor";
import { guest } from "./executor-guest";

let resume: (() => void) | undefined;
const continued = new Promise<void>(resolve => { resume = resolve; });
const host = {
  crossOriginIsolated: true,
  location: { href: "https://example.test/executor-worker.js" },
  fetch: globalThis.fetch.bind(globalThis),
  postMessage(message: WorkerMessage, transfer: Transferable[] = []) { globalThis.postMessage(message, transfer); },
};
globalThis.onmessage = async (event: MessageEvent) => {
  if (event.data === "finish") { resume?.(); return; }
  if (typeof event.data !== "string") throw new Error("Expected route owner");
  const connection = createFilesystemConnection();
  const request: RunRequest = {
    engine: "browser", adapter: "bun", module: guest(0), args: ["bun"], env: {},
    filesystem: connection.client, runtimeProcess: createWorkerProcessTransport({ pid: 1, job: 1 }),
    trace: false, net: null, moduleCache: null, slots: "off", sharedObjects: { owner: event.data },
  };
  const executor = createBunExecutor(request, host);
  try {
    await bootstrap(request, { ...executor, setup(context) {
      context.fs.preopen = () => 1; context.fs.retain = () => {}; context.fs.release = () => {};
      executor.setup?.(context);
    }, async run(context, exited) {
      await continued;
      return executor.run?.(context, exited) ?? exited ?? 0;
    } }, host);
  } finally {
    connection.client.port.close(); connection.server.port.close();
    globalThis.postMessage({ type: "fixture-cleaned" });
  }
};
