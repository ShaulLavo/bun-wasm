import { Worker, type WorkerOptions } from "node:worker_threads";
import { writeSync } from "node:fs";

export function createNodeWorker(url: string | URL, options: WorkerOptions, stackMb: number): Worker {
  const limits = options.resourceLimits;
  const worker = new Worker(url, {
    ...options,
    resourceLimits: { maxOldGenerationSizeMb: 512, ...limits, stackSizeMb: Math.max(stackMb, limits?.stackSizeMb ?? 0) },
  });
  worker.on("error", error => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_WORKER_OUT_OF_MEMORY") return;
    writeSync(2, `node-host: ${error.stack ?? error}\n`);
  });
  return worker;
}
