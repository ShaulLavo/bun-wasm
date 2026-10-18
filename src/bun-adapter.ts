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

export class BunWasmExecutableConflictError extends Error {
  readonly code = "BUN_WASM_EXECUTABLE_CONFLICT";
  constructor(readonly path: string) {
    super(`Cannot install Bun: a different filesystem entry already exists at ${path}`);
    this.name = "BunWasmExecutableConflictError";
  }
}

export interface BunAdapterOptions extends LoadBunWasmOptions {
  /** Bundler-produced module worker URL, reserved for the future process bridge. */
  readonly workerUrl?: string | URL;
  /** Engine for the registered executable; defaults to browser. */
  readonly engine?: Engine;
  /** Absolute canonical executable paths; defaults to /bin/bun. */
  readonly executables?: readonly string[];
}

export interface BunAdapterInstallation {
  /** Unregister this install. Existing processes and filesystem markers keep going. */
  dispose(): void;
}

const installations = new WeakMap<Runtime, BunAdapterInstallation>();
const installing = new WeakSet<Runtime>();
const executableMarker = new TextEncoder().encode("bun-wasm registered executable\n");
const matchesMarker = (bytes: Uint8Array | undefined): boolean => bytes !== undefined
  && bytes.length === executableMarker.length && bytes.every((byte, index) => byte === executableMarker[index]);

/** Register Bun on a caller-owned Runtime, provisioning executable files without reserving a root. */
export async function installBunAdapters(runtime: Runtime, options: BunAdapterOptions = {}): Promise<BunAdapterInstallation> {
  if (installations.has(runtime) || installing.has(runtime)) throw new Error("bun-wasm adapters are already installed on this Runtime");
  if (options.workerUrl !== undefined && !options.workerUrl.toString()) throw new TypeError("workerUrl must not be empty");
  const engine = options.engine ?? "browser";
  if (!["quickjs", "jsc", "browser"].includes(engine)) throw new TypeError(`Unknown Bun engine: ${engine}`);
  if (engine !== "browser" && !options.module && !options.asset) {
    throw new TypeError(`${engine} requires its matching guest module or asset descriptor`);
  }
  const names = Array.from(options.executables ?? ["/bin/bun"]);
  for (const name of names) {
    if (!name.startsWith("/") || name === "/" || name.includes("\0")
      || name.slice(1).split("/").some(part => !part || part === "." || part === "..")) {
      throw new TypeError(`Bun executable path must be absolute and canonical: ${name}`);
    }
  }
  const unregisters: Array<() => void> = [];
  const created: string[] = [];
  // Packaging boundary: the generic process bridge is not implemented here yet.
  // Keep this unconditional typed rejection until that bridge replaces these registrations.
  const fail = async (): Promise<never> => { throw new BunWasmProcessUnavailableError(); };
  async function installMarkers() {
    // Check every path before creating any files, so a conflict cannot leave a partial install.
    for (const name of names) {
      const entry = await runtime.filesystem.lookup(name);
      if (entry && (entry.kind !== "file" || !matchesMarker(await runtime.filesystem.readFile(name)))) {
        throw new BunWasmExecutableConflictError(name);
      }
    }
    for (const name of names) {
      const existing = await runtime.filesystem.lookup(name);
      if (existing) {
        if (existing.kind !== "file" || !matchesMarker(await runtime.filesystem.readFile(name))) throw new BunWasmExecutableConflictError(name);
        continue;
      }
      await runtime.filesystem.mkdirp(name.slice(0, name.lastIndexOf("/")) || "/");
      // Recheck after creating parents, rather than overwriting an entry created meanwhile.
      if (await runtime.filesystem.lookup(name)) {
        if (!matchesMarker(await runtime.filesystem.readFile(name))) throw new BunWasmExecutableConflictError(name);
        continue;
      }
      await runtime.filesystem.writeFile(name, executableMarker);
      created.push(name);
    }
  }
  async function rollbackMarkers() {
    for (const name of created.reverse()) {
      try {
        if (matchesMarker(await runtime.filesystem.readFile(name))) await runtime.filesystem.remove(name);
      } catch {
        // Clear a failed rollback mutation too, so cleanup of other markers can continue.
        try { await runtime.filesystem.drain(); } catch {}
      }
    }
  }
  installing.add(runtime);
  try {
    for (const name of ["quickjs", "jsc", "browser"] as const) unregisters.push(runtime.registerAdapter(`bun:${name}`, fail));
    for (const name of names) unregisters.push(runtime.registerProgram(name, {
      adapter: `bun:${engine}`, cooperative: true,
      // Program loading precedes launch in Waffle: refuse before any guest download.
      module: fail,
    }));
    await installMarkers();
  } catch (error) {
    for (const unregister of unregisters.reverse()) unregister();
    // Waffle also queues mutation errors for drain; consume the already-caught failure
    // before rollback reads, or their drain would fail without checking the marker.
    try { await runtime.filesystem.drain(); } catch {}
    await rollbackMarkers();
    throw error;
  } finally { installing.delete(runtime); }
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
