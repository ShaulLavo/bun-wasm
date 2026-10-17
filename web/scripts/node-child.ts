import { Worker, type WorkerOptions } from "node:worker_threads";
import type { ChildTransport, ChildWorker } from "../src/subprocess.ts";

export function launchNodeChild(entry: URL, options: WorkerOptions, transport: ChildTransport): ChildWorker {
  const supervisor = new Worker(new URL("./node-child-supervisor.ts", import.meta.url), {
    workerData: { entry: entry.href, options, transport },
  });
  const exited = new Promise<number>(resolve => supervisor.once("exit", resolve));
  return {
    starting: true,
    terminate() {
      supervisor.postMessage("terminate");
      return exited;
    },
  };
}
