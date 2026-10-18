import { installBunAdapters } from "bun-wasm";
import bunWorkerUrl from "bun-wasm/worker?worker&url";

// This fixture deliberately resolves through package exports, not a checkout-relative worker.
export const install = (runtime: Parameters<typeof installBunAdapters>[0]) => installBunAdapters(runtime, { workerUrl: bunWorkerUrl });

Reflect.set(globalThis, "bunPackageFixture", install);
