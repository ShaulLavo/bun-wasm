import type { ProcessRuntime } from "./process-runtime.js";
import { packageContinuation } from "./package-continuation.js";
import { PACKAGE_ADAPTER } from "./package-continuation-binding.js";

const services = new WeakMap<ProcessRuntime, { commit(): void; rollback(): void }>();

/** One resource-free launcher per Runtime. Waffle resolves its adapter after exec admission. */
export function packageService(runtime: ProcessRuntime): { commit(): void; rollback(): void } {
  const existing = services.get(runtime);
  if (existing) return existing;
  const unregister = runtime.registerAdapter(PACKAGE_ADAPTER, packageContinuation({ filesystem: runtime.filesystem }));
  let committed = false;
  const service = {
    commit() { committed = true; },
    rollback() {
      if (committed) return;
      unregister();
      services.delete(runtime);
    },
  };
  services.set(runtime, service);
  return service;
}
