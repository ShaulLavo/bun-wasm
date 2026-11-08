import { isPairedEngine, programProfile } from "../../src/engine-kind";
import { ENGINES, isEngine } from "../../web/src/engine-loader";

export function engineFiles(engine: string): string[] {
  if (!isEngine(engine)) return [];
  return [ENGINES[engine].wasm].concat(isPairedEngine(engine) ? [programProfile(engine).side] : []);
}

export function registeredEngineFiles(): string[] {
  return Object.keys(ENGINES).flatMap(engineFiles);
}
