import type { Runtime } from "waffle";
import { FilesystemError } from "waffle/fs/protocol";
import { loadBunWasm, type LoadBunWasmOptions } from "./assets.js";

import { bunLauncher } from "../web/src/bun-launcher.js";
import { ENGINE_BIN } from "./executable-paths.js";
export type { Engine } from "../web/src/bun-executor.js";
import type { Engine } from "../web/src/bun-executor.js";

export class BunWasmExecutableConflictError extends Error {
  readonly code = "BUN_WASM_EXECUTABLE_CONFLICT";
  constructor(readonly path: string) {
    super(`Cannot install Bun: a different filesystem entry already exists at ${path}`);
    this.name = "BunWasmExecutableConflictError";
  }
}

export interface BunAdapterOptions extends LoadBunWasmOptions {
  /** Bundler-produced module worker URL running bun-wasm/worker. */
  readonly workerUrl: string | URL;
  /** Engine for the registered executable; defaults to browser. */
  readonly engine?: Engine;
  /** Absolute canonical executable paths; defaults to bun and node in the selected engine bin directory. */
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

async function createExecutable(runtime: Runtime, name: string): Promise<boolean> {
  try {
    await runtime.filesystem.writeFile(name, executableMarker, { exclusive: true });
    return true;
  } catch (error) {
    if (!(error instanceof FilesystemError) || error.errno !== 20) throw error;
    // A rejected mutation is also queued for drain. Consume that same EEXIST before
    // inspecting the winner, without swallowing an unrelated queued storage failure.
    try { await runtime.filesystem.drain(); }
    catch (queuedError) { if (queuedError !== error) throw queuedError; }
    const entry = await runtime.filesystem.lookup(name);
    if (entry?.kind !== "file" || !matchesMarker(await runtime.filesystem.readFile(name))) {
      throw new BunWasmExecutableConflictError(name);
    }
    return false;
  }
}

/** Register Bun on a caller-owned Runtime, provisioning executable files without reserving a root. */
export async function installBunAdapters(runtime: Runtime, options: BunAdapterOptions): Promise<BunAdapterInstallation> {
  if (installations.has(runtime) || installing.has(runtime)) throw new Error("bun-wasm adapters are already installed on this Runtime");
  if (!options?.workerUrl?.toString()) throw new TypeError("workerUrl is required");
  const engine = options.engine ?? "browser";
  if (!["quickjs", "jsc", "browser"].includes(engine)) throw new TypeError(`Unknown Bun engine: ${engine}`);
  if (engine !== "browser" && !options.module && !options.asset) {
    throw new TypeError(`${engine} requires its matching guest module or asset descriptor`);
  }
  const names = Array.from(options.executables ?? [`${ENGINE_BIN[engine]}/bun`, `${ENGINE_BIN[engine]}/node`]);
  for (const name of names) {
    if (!name.startsWith("/") || name === "/" || name.includes("\0")
      || name.slice(1).split("/").some(part => !part || part === "." || part === "..")) {
      throw new TypeError(`Bun executable path must be absolute and canonical: ${name}`);
    }
  }
  const unregisters: Array<() => void> = [];
  const created: string[] = [];
  installing.add(runtime);
  try {
    for (const name of ["quickjs", "jsc", "browser"] as const) unregisters.push(runtime.registerAdapter(`bun:${name}`, bunLauncher(name, { workerUrl: options.workerUrl.toString() })));
    for (const name of names) unregisters.push(runtime.registerProgram(name, {
      adapter: `bun:${engine}`, cooperative: true,
      module: () => loadBunWasm(options),
    }));
    // Check every path before creating any files, so a conflict cannot leave a partial install.
    for (const name of names) {
      const entry = await runtime.filesystem.lookup(name);
      if (entry && (entry.kind !== "file" || !matchesMarker(await runtime.filesystem.readFile(name)))) {
        throw new BunWasmExecutableConflictError(name);
      }
    }
    for (const name of names) {
      await runtime.filesystem.mkdirp(name.slice(0, name.lastIndexOf("/")) || "/");
      if (await createExecutable(runtime, name)) created.push(name);
    }
  } catch (error) {
    for (const unregister of unregisters.reverse()) unregister();
    // Waffle also queues mutation errors for drain; consume the already-caught failure
    // before rollback reads, or their drain would fail without checking the marker.
    try { await runtime.filesystem.drain(); } catch {}
    for (const name of created.reverse()) {
      try {
        if (matchesMarker(await runtime.filesystem.readFile(name))) await runtime.filesystem.remove(name);
      } catch {
        // Clear a failed rollback mutation too, so cleanup of other markers can continue.
        try { await runtime.filesystem.drain(); } catch {}
      }
    }
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
