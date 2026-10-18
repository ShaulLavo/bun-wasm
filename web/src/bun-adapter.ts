import type { GuestLauncher, Runtime } from "waffle";
import { loadBunWasm, type LoadBunWasmOptions } from "./assets.js";
import { bunLauncher } from "./bun-launcher.js";

export type Engine = "quickjs" | "jsc" | "browser";

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
 * The generic Waffle process service owns process admission, worker lifetime, descriptors and pipes.
 * This installer only owns the registrations it creates.
 */
export function installBunAdapters(runtime: Runtime, options: BunAdapterOptions): BunAdapterInstallation {
  if (installations.has(runtime)) throw new Error("bun-wasm adapters are already installed on this Runtime");
  if (!options || !options.workerUrl?.toString()) throw new TypeError("workerUrl is required");
  const engine = options.engine ?? "browser";
  if (engine !== "quickjs" && engine !== "jsc" && engine !== "browser") throw new TypeError(`Unknown Bun engine: ${engine}`);
  if (engine !== "browser" && !options.module && !options.asset) {
    throw new TypeError(`${engine} requires its matching guest module or asset descriptor`);
  }
  const names = Array.from(options.executables ?? ["bun", "/bin/bun"]);
  const workerUrl = options.workerUrl.toString();
  const launchers: Record<Engine, GuestLauncher> = {
    quickjs: bunLauncher("quickjs", { workerUrl }),
    jsc: bunLauncher("jsc", { workerUrl }),
    browser: bunLauncher("browser", { workerUrl }),
  };
  const unregisters: Array<() => void> = [];
  try {
    for (const name of ["quickjs", "jsc", "browser"] as const) unregisters.push(runtime.registerAdapter(`bun:${name}`, launchers[name]));
    const module = () => loadBunWasm(options);
    for (const name of names) unregisters.push(runtime.registerProgram(name, {
      adapter: `bun:${engine}`,
      cooperative: true,
      module,
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
