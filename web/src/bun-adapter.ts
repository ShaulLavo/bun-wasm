import type { Runtime } from "waffle";
import type { LoadBunWasmOptions } from "./assets.js";

export type Engine = "quickjs" | "jsc" | "browser";

/** The generic Waffle process bridge, not the legacy controller path, is required. */
export class BunWasmProcessUnavailableError extends Error {
  readonly code = "BUN_WASM_PROCESS_UNAVAILABLE";
  constructor() {
    super("bun-wasm process spawning requires the generic Waffle process bridge (step 7b)");
    this.name = "BunWasmProcessUnavailableError";
  }
}

export interface BunAdapterOptions extends LoadBunWasmOptions {
  /** Bundler-produced module worker URL. */
  readonly workerUrl: string | URL;
  /** Engine for the registered bun executable; defaults to browser. */
  readonly engine?: Engine;
  /** Executable names owned by this install; defaults to bun and /bin/bun. */
  readonly executables?: readonly string[];
}

export interface BunAdapterInstallation {
  /** Unregister this install. Existing processes keep going; a later install is allowed. */
  dispose(): void;
}

const installations = new WeakMap<Runtime, BunAdapterInstallation>();

/**
 * Register Bun engines and executable aliases on a caller-owned Runtime, without reserving a root.
 * This packaging-only API deliberately refuses to launch until the generic process bridge lands.
 * It never installs the legacy controller-backed subprocess path.
 */
export function installBunAdapters(runtime: Runtime, options: BunAdapterOptions): BunAdapterInstallation {
  if (installations.has(runtime)) throw new Error("bun-wasm adapters are already installed on this Runtime");
  if (!options || !options.workerUrl?.toString()) throw new TypeError("workerUrl is required");
  const engine = options.engine ?? "browser";
  if (!["quickjs", "jsc", "browser"].includes(engine)) throw new TypeError(`Unknown Bun engine: ${engine}`);
  if (engine !== "browser" && !options.module && !options.asset) {
    throw new TypeError(`${engine} requires its matching guest module or asset descriptor`);
  }
  const names = Array.from(options.executables ?? ["bun", "/bin/bun"]);
  const unregisters: Array<() => void> = [];
  const fail = async (): Promise<never> => { throw new BunWasmProcessUnavailableError(); };
  try {
    for (const name of ["quickjs", "jsc", "browser"] as const) unregisters.push(runtime.registerAdapter(`bun:${name}`, fail));
    for (const name of names) unregisters.push(runtime.registerProgram(name, {
      adapter: `bun:${engine}`, cooperative: true,
      // Program loading precedes launch in Waffle: refuse here too, before any download.
      module: fail,
    }));
  } catch (error) {
    for (const unregister of unregisters.reverse()) unregister();
    throw error;
  }
  let active = true;
  const installation: BunAdapterInstallation = {
    dispose() {
      if (!active) return;
      active = false;
      for (const unregister of unregisters.splice(0).reverse()) unregister();
      if (installations.get(runtime) === installation) installations.delete(runtime);
    },
  };
  installations.set(runtime, installation);
  return installation;
}
