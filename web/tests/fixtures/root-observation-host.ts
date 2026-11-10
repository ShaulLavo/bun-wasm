import { createRuntime } from "waffle";

export function rootObservationHost(WorkerConstructor: typeof Worker) {
  const previous = new Map(["Worker", "location", "crossOriginIsolated"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const restore = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkerConstructor });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
  try {
    const runtime = createRuntime({ filesystem: { workerURL: new URL("../../src/fs-worker.ts", import.meta.url), mode: "memory" } });
    return { runtime, restore };
  } catch (error) { restore(); throw error; }
}

export function containsStopFailure(error: unknown, reason: unknown): boolean {
  return Object.is(error, reason) || error instanceof AggregateError && error.errors.some((entry: unknown) => containsStopFailure(entry, reason));
}
