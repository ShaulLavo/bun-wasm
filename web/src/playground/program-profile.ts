import type { GuestLauncher, Runtime } from "waffle";
import { isSharedGroupCore, type Engine } from "../../../src/engine-kind";
import { ENGINE_BIN } from "../../../src/executable-paths";

export type PlaygroundProfile = "split" | "shared-group";

export function playgroundProfile(value: string | null): PlaygroundProfile {
  if (value === null || value === "split") return "split";
  if (value === "shared-group") return value;
  throw new TypeError(`Unknown Bun program profile: ${value}`);
}

export function requireProfileEngine(engine: Engine, profile: PlaygroundProfile): void {
  if (profile === "shared-group" && engine !== "quickjs" && engine !== "jsc") {
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
  const removeAdapter = runtime.registerAdapter(`bun:${engine}`, options.launcher);
  const removals: Array<() => void> = [];
  const dispose = () => { for (const remove of removals) remove(); removeAdapter(); };
  try {
    await runtime.filesystem.mkdirp(bin);
    for (const name of ["bun", "node", "nodejs"]) {
      const path = `${bin}/${name}`;
      removals.push(runtime.registerProgram(path, { adapter: `bun:${engine}`, cooperative: true, module: () => module }));
      await runtime.filesystem.writeFile(path, "bun-wasm registered executable\n");
    }
    return { profile, bin, dispose };
  } catch (error) { dispose(); throw error; }
}
