import type { ProcessRuntime } from "./process-runtime.js";
import { FilesystemClient } from "waffle/fs/client";
import { createExecutable } from "./executable-marker.js";
import { PACKAGE_ADAPTER, PACKAGE_CONTINUATION } from "./package-continuation-binding.js";

interface PackageService {
  users: number;
  committed: boolean;
  unregisterAdapter(): void;
  unregisterProgram?: () => void;
}
const services = new WeakMap<ProcessRuntime, PackageService>();
const continuationModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

/** Each consumer owns a target lease; the resource-free launcher lives with the Runtime. */
export function packageService(runtime: ProcessRuntime) {
  let service = services.get(runtime);
  if (!service) {
    service = { users: 0, committed: false,
      unregisterAdapter: runtime.registerHostAdapter(PACKAGE_ADAPTER, async (context, process) => {
        const { packageContinuation } = await import("./package-continuation.js");
        return packageContinuation({ filesystem: runtime.filesystem })(context, process);
      }) };
    services.set(runtime, service);
  }
  const owner = service;
  try {
    owner.unregisterProgram ??= runtime.registerProgram(PACKAGE_CONTINUATION, { adapter: PACKAGE_ADAPTER, cooperative: true, module: continuationModule });
  } catch (error) {
    rollbackService(runtime, owner);
    throw error;
  }
  owner.users++;
  let active = true;
  let committed = false;
  const dispose = () => {
    if (!active) return;
    active = false;
    if (--owner.users) return;
    owner.unregisterProgram?.();
    owner.unregisterProgram = undefined;
  };
  return {
    commit() { if (active) { committed = true; owner.committed = true; } },
    rollback() { if (committed) return; dispose(); rollbackService(runtime, owner); },
    dispose,
  };
}

function rollbackService(runtime: ProcessRuntime, service: PackageService): void {
  if (service.committed || service.users || services.get(runtime) !== service) return;
  service.unregisterAdapter();
  services.delete(runtime);
}

/** Standalone consumers provision the same checked marker as the public installer. */
export async function preparePackageContinuation(runtime: ProcessRuntime): Promise<void> {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  await runtime.filesystem.resolvePath("/");
  if (runtime.disposed) throw new Error("Runtime is disposed");
  const filesystem = new FilesystemClient(runtime.filesystem.fork());
  try {
    await filesystem.asyncCall("mkdirp", ["/.bun-wasm"]);
    await createExecutable(filesystem, PACKAGE_CONTINUATION);
  } finally { filesystem.dispose(); }
}
