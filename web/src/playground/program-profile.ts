import type { GuestLauncher, Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { isSharedGroupCore, pairedEngines, type Engine } from "../../../src/engine-kind";
import { projectTemplate } from "./project-templates";
import { ENGINE_BIN } from "../../../src/executable-paths";
import { packageService, preparePackageContinuation } from "../../../src/package-continuation-installation";
import { createExecutable, rollbackExecutables } from "../../../src/executable-marker";

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
  runtime: Runtime; engine: Engine; module: WebAssembly.Module; profile: PlaygroundProfile;
  launcher(engine: Engine): GuestLauncher;
  loadModule(engine: Engine, profile: PlaygroundProfile): Promise<WebAssembly.Module>;
}): Promise<{ profile: PlaygroundProfile; bin: string; dispose(): void }> {
  const { runtime, engine, module } = options;
  requireProfileEngine(engine, options.profile);
  const profile = isSharedGroupCore(module) ? "shared-group" : "split";
  if (profile !== options.profile) throw new TypeError(`Requested ${options.profile} program profile, but the prepared ${engine} core is ${profile}`);
  const bin = ENGINE_BIN[engine];
  await runtime.filesystem.resolvePath("/");
  const filesystem = new FilesystemClient(runtime.filesystem.fork());
  let packages: ReturnType<typeof packageService> | undefined;
  const removals: Array<() => void> = [];
  const created: string[] = [];
  const dispose = () => { for (const remove of removals.splice(0).reverse()) remove(); packages?.dispose(); };
  async function register(provider: Engine): Promise<void> {
    removals.push(runtime.registerAdapter(`bun:${provider}`, options.launcher(provider)));
    const directory = ENGINE_BIN[provider];
    const memoryProfile = provider === "browser" ? "split" : profile;
    let loading: Promise<WebAssembly.Module> | undefined;
    const load = provider === engine ? () => module : () => loading ??= options.loadModule(provider, memoryProfile);
    await filesystem.asyncCall("mkdirp", [directory]);
    for (const name of ["bun", "bunx", "node", "nodejs"]) {
      const path = `${directory}/${name}`;
      removals.push(runtime.registerProgram(path, { adapter: `bun:${provider}`, cooperative: true, module: load }));
      if (await createExecutable(filesystem, path)) created.push(path);
    }
  }
  try {
    packages = packageService(runtime);
    const providers: readonly Engine[] = pairedEngines;
    for (const provider of providers.concat(["browser"], engine === "spidermonkey" ? [engine] : [])) await register(provider);
    await preparePackageContinuation(runtime);
    packages.commit();
    return { profile, bin, dispose };
  } catch (error) { dispose(); packages?.rollback(); await rollbackExecutables(filesystem, created); throw error; }
  finally { filesystem.dispose(); }
}
