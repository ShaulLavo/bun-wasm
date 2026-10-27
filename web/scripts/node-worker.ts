import { Worker, type WorkerOptions } from "node:worker_threads";

export function createNodeWorker(url: string | URL, options: WorkerOptions, stackMb: number): Worker {
  const limits = options.resourceLimits;
  return new Worker(url, {
    ...options,
    resourceLimits: { maxOldGenerationSizeMb: 128, ...limits, stackSizeMb: Math.max(stackMb, limits?.stackSizeMb ?? 0) },
  });
}
