import { isPairedEngine, programProfile } from "../../src/engine-kind";
import { ENGINES, isEngine } from "../../web/src/engine-loader";
import { profileAsset, requireProfileEngine, type ProgramMemoryProfile } from "../../web/src/program-profile";

export function engineFiles(engine: string): string[] { return profileEngineFiles(engine, "split"); }

export function profileEngineFiles(engine: string, profile: ProgramMemoryProfile): string[] {
  if (!isEngine(engine)) return [];
  requireProfileEngine(engine, profile);
  return [ENGINES[engine].wasm].concat(isPairedEngine(engine) ? [programProfile(engine).side] : []).map(name => profileAsset(name, profile));
}

export function registeredEngineGroups(): string[][] {
  return Object.keys(ENGINES).map(engineFiles);
}
