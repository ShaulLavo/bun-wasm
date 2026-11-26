import type { ProcessRuntime } from "./process-runtime.js";
import { FilesystemClient } from "waffle/fs/client";
import { BunWasmExecutableConflictError, createExecutable, matchesMarker, rollbackExecutables } from "./executable-marker.js";
export { BunWasmExecutableConflictError } from "./executable-marker.js";
import { loadBunWasm, type LoadBunWasmOptions } from "./assets.js";

import type { BunNetworkOptions } from "../web/src/net/helper.js";
import { bunLauncher } from "../web/src/bun-launcher.js";
import { isPairedEngine, pairedEngines, programKind, type Engine } from "./engine-kind.js";
import { ENGINE_BIN } from "./executable-paths.js";
import { packageService } from "./package-continuation-installation.js";
import { PACKAGE_CONTINUATION } from "./package-continuation-binding.js";
export type { Engine } from "./engine-kind.js";

export interface BunAdapterOptions extends LoadBunWasmOptions {
  readonly network?: BunNetworkOptions;
  /** Bundler-produced module worker URL running bun-wasm/worker. */
  readonly workerUrl: string | URL;
  /** Bundler-produced module worker URL running bun-wasm/notification-worker (fs.watch wakes). */
  readonly notificationWorkerUrl: string | URL;
  /** Engine for the registered executable; defaults to browser. */
  readonly engine?: Engine;
  /** Absolute canonical executable paths; defaults to bun, node and nodejs in the selected engine bin directory. */
  readonly executables?: readonly string[];
  /** Loads bun-tools.wasm for `bun lint`, `bun fmt` and `bun check`, on their first use. Without it they exit 1. */
  readonly loadTools?: () => Promise<WebAssembly.Module>;
}

export interface BunAdapterInstallation {
  /** Unregister this install. Existing processes and filesystem markers keep going. */
  dispose(): void;
}

const installations = new WeakMap<ProcessRuntime, BunAdapterInstallation>();
const installing = new WeakSet<ProcessRuntime>();
function onceLoader(load: () => Promise<WebAssembly.Module>): () => Promise<WebAssembly.Module> {
  let loading: Promise<WebAssembly.Module> | undefined;
  return () => loading ??= load().catch(error => { loading = undefined; throw error; });
}

function moduleLoader(options: BunAdapterOptions, engine: Engine): () => Promise<WebAssembly.Module> {
  return onceLoader(() => selectedModule(options, engine));
}

async function selectedModule(options: BunAdapterOptions, engine: Engine): Promise<WebAssembly.Module> {
  const module = await loadBunWasm(options);
  const expected = engine === "browser" ? "single" : engine;
  const declared = programKind(module);
  if (declared !== expected) throw new TypeError(`Selected ${engine} core declares ${declared}`);
  return module;
}

/** Register Bun on a caller-owned Runtime, provisioning executable files without reserving a root. */
export async function installBunAdapters(runtime: ProcessRuntime, options: BunAdapterOptions): Promise<BunAdapterInstallation> {
  if (installations.has(runtime) || installing.has(runtime)) throw new Error("bun-wasm adapters are already installed on this Runtime");
  if (!options?.workerUrl?.toString()) throw new TypeError("workerUrl is required");
  if (!options.notificationWorkerUrl?.toString()) throw new TypeError("notificationWorkerUrl is required");
  const engine = options.engine ?? "browser";
  if (engine !== "browser" && !isPairedEngine(engine)) throw new TypeError(`Unknown Bun engine: ${engine}`);
  if (engine !== "browser" && !options.module && !options.asset) {
    throw new TypeError(`${engine} requires its matching guest module or asset descriptor`);
  }
  const names = Array.from(options.executables ?? [`${ENGINE_BIN[engine]}/bun`, `${ENGINE_BIN[engine]}/node`, `${ENGINE_BIN[engine]}/nodejs`]);
  for (const name of names) {
    if (!name.startsWith("/") || name === "/" || name.includes("\0")
      || name.slice(1).split("/").some(part => !part || part === "." || part === "..")) {
      throw new TypeError(`Bun executable path must be absolute and canonical: ${name}`);
    }
  }
  const unregisters: Array<() => void> = [];
  const markers = names.concat([PACKAGE_CONTINUATION]);
  const created: string[] = [];
  let filesystem: FilesystemClient | undefined;
  let packages: ReturnType<typeof packageService> | undefined;
  installing.add(runtime);
  try {
    // The page-side ordering primitive waits for previously queued writes without
    // consuming their explicit-drain-owned failure. The fork has no page write queue:
    // every installer operation observes only its own completion, including EEXIST.
    await runtime.filesystem.resolvePath("/");
    filesystem = new FilesystemClient(runtime.filesystem.fork());
    packages = packageService(runtime);
    const defaults: readonly Engine[] = pairedEngines;
    const adapters = defaults.concat(["browser"], engine === "spidermonkey" ? [engine] : []);
    const loadTools = options.loadTools && onceLoader(options.loadTools);
    for (const name of adapters) unregisters.push(runtime.registerAdapter(`bun:${name}`, bunLauncher(name, { workerUrl: options.workerUrl.toString(), notificationWorkerUrl: options.notificationWorkerUrl.toString(), loadTools, runtime, network: options.network })));
    const loadModule = moduleLoader(options, engine);
    for (const name of names) unregisters.push(runtime.registerProgram(name, {
      adapter: `bun:${engine}`, cooperative: true, module: loadModule,
    }));
    // Check every path before creating any files, so a conflict cannot leave a partial install.
    for (const name of markers) {
      const entry = await filesystem.asyncCall("lookup", [name]);
      if (entry && (entry.kind !== "file" || !matchesMarker(await filesystem.asyncCall("readFile", [name])))) {
        throw new BunWasmExecutableConflictError(name);
      }
    }
    for (const name of markers) {
      await filesystem.asyncCall("mkdirp", [name.slice(0, name.lastIndexOf("/")) || "/"]);
      if (await createExecutable(filesystem, name)) created.push(name);
    }
  } catch (error) {
    for (const unregister of unregisters.reverse()) unregister();
    packages?.rollback();
    if (filesystem) await rollbackExecutables(filesystem, created);
    throw error;
  } finally {
    try { filesystem?.dispose(); }
    finally { installing.delete(runtime); }
  }
  let active = true;
  const installation: BunAdapterInstallation = {
    dispose() {
      if (!active) return;
      active = false;
      for (const unregister of unregisters.splice(0).reverse()) unregister();
      packages?.dispose();
      if (installations.get(runtime) === installation) installations.delete(runtime);
    },
  };
  packages?.commit();
  installations.set(runtime, installation);
  return installation;
}

