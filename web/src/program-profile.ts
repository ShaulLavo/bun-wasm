import { isSharedGroupCore, type Engine } from "../../src/engine-kind";

export type ProgramMemoryProfile = "split" | "shared-group";

export function parseMemoryProfile(value: unknown): ProgramMemoryProfile {
  if (value === null || value === undefined || value === "split") return "split";
  if (value === "shared-group") return value;
  throw new TypeError(`Unknown Bun program memory profile: ${String(value)}`);
}

export function requireProfileEngine(engine: Engine, profile: ProgramMemoryProfile): void {
  if (profile === "shared-group" && engine === "browser") {
    throw new TypeError(`Bun ${engine} shared-group profile is unavailable in this host`);
  }
}

export function profileAsset(name: string, profile: ProgramMemoryProfile): string {
  return profile === "split" ? name : `profiles/${profile}/${name}`;
}

export function verifyMemoryProfile(module: WebAssembly.Module, profile: ProgramMemoryProfile): void {
  const actual = isSharedGroupCore(module) ? "shared-group" : "split";
  if (actual !== profile) throw new TypeError(`Bun program profile mismatch: selected ${profile}, received ${actual}`);
}
