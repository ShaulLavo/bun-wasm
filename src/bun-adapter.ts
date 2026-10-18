import type { Runtime } from "waffle";
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
    // Preflight every path before writing; provisionMarker rechecks after parent creation.
    for (const name of names) await checkMarker(runtime.filesystem, name);
    for (const name of names) await provisionMarker(runtime.filesystem, name, created);
  } catch (error) {
    for (const unregister of unregisters.reverse()) unregister();
    await clearMutationFailure(runtime.filesystem);
    for (const name of created.reverse()) await rollbackMarker(runtime.filesystem, name);
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

async function checkMarker(filesystem: Runtime["filesystem"], path: string): Promise<boolean> {
  const entry = await filesystem.lookup(path);
  if (!entry) return false;
  if (entry.kind !== "file" || !matchesMarker(await filesystem.readFile(path))) throw new BunWasmExecutableConflictError(path);
  return true;
}

async function provisionMarker(filesystem: Runtime["filesystem"], path: string, created: string[]): Promise<void> {
  if (await checkMarker(filesystem, path)) return;
  await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")) || "/");
  if (await checkMarker(filesystem, path)) return;
  await filesystem.writeFile(path, executableMarker);
  created.push(path);
}

async function clearMutationFailure(filesystem: Runtime["filesystem"]): Promise<void> {
  // Waffle queues mutation failures for drain, including failures already caught here.
  try { await filesystem.drain(); } catch {}
}

async function rollbackMarker(filesystem: Runtime["filesystem"], path: string): Promise<void> {
  try {
    if (matchesMarker(await filesystem.readFile(path))) await filesystem.remove(path);
  } catch {
    await clearMutationFailure(filesystem);
  }
}
