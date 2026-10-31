import type { ProcessRuntime } from "./process-runtime.js";
import { installRuntimeSharedObjects } from "../web/src/shared-objects/runtime.js";

export interface BunSharedObjects { close(): void }

/**
 * Opt-in: lets Bun processes on this Runtime share SharedArrayBuffer, shared Memory and Module
 * across workers. Separate from installBunAdapters, whose dispose keeps live processes running;
 * close() here revokes their shared-object routes.
 */
export function installBunSharedObjects(runtime: ProcessRuntime): BunSharedObjects {
  return installRuntimeSharedObjects(runtime);
}
