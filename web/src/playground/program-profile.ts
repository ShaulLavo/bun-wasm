import type { GuestLauncher, Runtime } from "waffle";
import { isSharedGroupCore, type Engine } from "../../../src/engine-kind";
import { ENGINE_BIN } from "../../../src/executable-paths";
import { packageService, preparePackageContinuation } from "../../../src/package-continuation-installation";

export type PlaygroundProfile = "split" | "shared-group";

export function playgroundProfile(value: string | null): PlaygroundProfile {
  if (value === null || value === "split") return "split";
  if (value === "shared-group") return value;
  throw new TypeError(`Unknown Bun program profile: ${value}`);
}

export function templateProfile(engine: Engine, template: string | undefined, requested?: PlaygroundProfile): PlaygroundProfile {
  const profile = requested ?? (template === "angular" && engine !== "browser" ? "shared-group" : "split");
  requireProfileEngine(engine, profile);
  return profile;
}

function requireProfileEngine(engine: Engine, profile: PlaygroundProfile): void {
  if (profile === "shared-group" && engine === "browser") {
    throw new TypeError(`The ${engine} engine does not support the shared-group playground profile`);
  }
}

export async function registerPlaygroundBun(options: {
  runtime: Runtime; engine: Engine; module: WebAssembly.Module; profile: PlaygroundProfile; launcher: GuestLauncher;
}): Promise<{ profile: PlaygroundProfile; bin: string; dispose(): void }> {
  const { runtime, engine, module } = options;
  requireProfileEngine(engine, options.profile);
  const profile = isSharedGroupCore(module) ? "shared-group" : "split";
  if (profile !== options.profile) throw new TypeError(`Requested ${options.profile} program profile, but the prepared ${engine} core is ${profile}`);
  const bin = ENGINE_BIN[engine];
  const packages = packageService(runtime);
  const removals: Array<() => void> = [];
  const dispose = () => { for (const remove of removals.splice(0).reverse()) remove(); packages.dispose(); };
  try {
    removals.push(runtime.registerAdapter(`bun:${engine}`, options.launcher));
    await runtime.filesystem.mkdirp(bin);
    for (const name of ["bun", "node", "nodejs"]) {
      const path = `${bin}/${name}`;
      removals.push(runtime.registerProgram(path, { adapter: `bun:${engine}`, cooperative: true, module: () => module }));
      await runtime.filesystem.writeFile(path, "bun-wasm registered executable\n");
    }
    await preparePackageContinuation(runtime);
    packages.commit();
    return { profile, bin, dispose };
  } catch (error) { dispose(); packages.rollback(); throw error; }
}
