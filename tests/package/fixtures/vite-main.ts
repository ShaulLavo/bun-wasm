import { installBunAdapters } from "bun-wasm";
import bunWorkerUrl from "bun-wasm/worker?worker&url";
import notificationWorkerUrl from "bun-wasm/notification-worker?worker&url";

// This fixture deliberately resolves through package exports, not a checkout-relative worker.
export const install = (runtime: Parameters<typeof installBunAdapters>[0]) => installBunAdapters(runtime, { workerUrl: bunWorkerUrl, notificationWorkerUrl });

Reflect.set(globalThis, "bunPackageFixture", install);
