import type { GuestLauncher, Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { isSharedGroupCore, pairedEngines, type Engine } from "../../../src/engine-kind";
import { projectTemplate } from "./project-templates";
import { ENGINE_BIN } from "../../../src/executable-paths";
import { packageService, preparePackageContinuation } from "../../../src/package-continuation-installation";
import { createExecutable, executableMarker } from "../../../src/executable-marker";
import { PACKAGE_CONTINUATION } from "../../../src/package-continuation-binding";
import { ProvisionRollbackError, type ProvisioningStatus } from "../browser-programs";
import { rollbackMarkersDurably } from "../workspace-provision";

export type PlaygroundProfile = "split" | "shared-group";

export function playgroundProfile(value: string | null): PlaygroundProfile {
  if (value === null || value === "split") return "split";
  if (value === "shared-group") return value;
  throw new TypeError(`Unknown Bun program profile: ${value}`);
}

export function templateProfile(engine: Engine, template: string | undefined, requested?: PlaygroundProfile): PlaygroundProfile {
  const profile = requested ?? (projectTemplate(template ?? null)?.sharedWorkers && engine !== "browser" ? "shared-group" : "split");
  requireProfileEngine(engine, profile);
  return profile;
}

function requireProfileEngine(engine: Engine, profile: PlaygroundProfile): void {
  if (profile === "shared-group" && engine === "browser") {
    throw new TypeError(`The ${engine} engine does not support the shared-group playground profile`);
  }
}

export async function registerPlaygroundBun(options: {
  runtime: Runtime;
  engine: Engine;
  module: WebAssembly.Module;
  profile: PlaygroundProfile;
  launcher(engine: Engine): GuestLauncher;
  loadModule(engine: Engine, profile: PlaygroundProfile): Promise<WebAssembly.Module>;
  /** True once the page gave up on startup; registration then rolls back before it commits. */
  abandoned?(): boolean;
  /** Runs a cleanup immediately if startup is abandoned while registration or its final flush is pending. */
  onAbandon?(cleanup: () => void): void;
  /** Optional admitted provisioning transaction wrapper (`provisionBinsLock` + `withWriterClaim`). */
  runTransaction?<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  onStateChange?(state: ProvisioningStatus): void;
}): Promise<{ profile: PlaygroundProfile; bin: string; dispose(): void }> {
  const { runtime, engine, module } = options;
  requireProfileEngine(engine, options.profile);
  const profile = isSharedGroupCore(module) ? "shared-group" : "split";
  if (profile !== options.profile) {
    throw new TypeError(`Requested ${options.profile} program profile, but the prepared ${engine} core is ${profile}`);
  }
  const bin = ENGINE_BIN[engine];

  const execute = async (signal: AbortSignal): Promise<{ profile: PlaygroundProfile; bin: string; dispose(): void }> => {
    options.onStateChange?.("pending");
    await runtime.filesystem.resolvePath("/");
    const filesystem = new FilesystemClient(runtime.filesystem.fork());
    let packages: ReturnType<typeof packageService> | undefined;
    const removals: Array<() => void> = [];
    const created: string[] = [];
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const remove of removals.splice(0).reverse()) remove();
      packages?.dispose();
    };
    options.onAbandon?.(dispose);
    const proceed = () => {
      if (signal.aborted || options.abandoned?.() || runtime.disposed) {
        throw new Error("Bun registration was abandoned with its startup");
      }
    };
    async function register(provider: Engine): Promise<void> {
      proceed();
      removals.push(runtime.registerAdapter(`bun:${provider}`, options.launcher(provider)));
      const directory = ENGINE_BIN[provider];
      const memoryProfile = provider === "browser" ? "split" : profile;
      let loading: Promise<WebAssembly.Module> | undefined;
      const load = provider === engine ? () => module : () => loading ??= options.loadModule(provider, memoryProfile);
      await filesystem.asyncCall("mkdirp", [directory]);
      for (const name of ["bun", "bunx", "node", "nodejs"]) {
        proceed();
        const path = `${directory}/${name}`;
        removals.push(runtime.registerProgram(path, { adapter: `bun:${provider}`, cooperative: true, module: load }));
        if (await createExecutable(filesystem, path)) created.push(path);
      }
    }
    try {
      proceed();
      packages = packageService(runtime);
      const providers: readonly Engine[] = pairedEngines;
      for (const provider of providers.concat(["browser"], engine === "spidermonkey" ? [engine] : [])) {
        await register(provider);
      }
      proceed();
      const continuationExisted = await filesystem.asyncCall("lookup", [PACKAGE_CONTINUATION]) !== undefined;
      proceed();
      await preparePackageContinuation(runtime);
      if (!continuationExisted) created.push(PACKAGE_CONTINUATION);
      // Flush and revalidate BEFORE commit, all strictly inside the admitted bins lock transaction.
      await runtime.filesystem.flush();
      proceed();
      packages.commit();
      options.onStateChange?.("committed");
      return { profile, bin, dispose };
    } catch (error) {
      dispose();
      packages?.rollback();
      try {
        await rollbackMarkersDurably(runtime.filesystem, created, executableMarker);
        options.onStateChange?.("idle");
      } catch (rollbackError) {
        options.onStateChange?.("rollback-failed");
        throw new ProvisionRollbackError([error, rollbackError], "Playground Bun marker rollback failed");
      }
      throw error;
    } finally {
      filesystem.dispose();
    }
  };

  if (options.runTransaction) {
    return await options.runTransaction(execute);
  }
  return await execute(new AbortController().signal);
}
