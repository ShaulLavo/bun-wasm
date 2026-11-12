import { declareModuleMemory, pages, type MemoryDeclaration } from "waffle";
import { wasmMemoryLimits } from "./engine-kind.ts";

export function memoryDeclarations(source: Uint8Array): readonly MemoryDeclaration[] {
  return wasmMemoryLimits(source).map(memory => memory.shared
    ? { kind: "shared", origin: memory.origin, initialPages: pages(memory.initial), maximumPages: pages(memory.maximum ?? 65_536) }
    : { kind: "private", origin: memory.origin, maximumPages: pages(memory.maximum ?? 65_536) });
}

const declarations = new WeakMap<WebAssembly.Module, readonly MemoryDeclaration[]>();
export interface CoreMemoryLimits { declaredMaximumBytes: number | null; factoryMaximumBytes: number | null }
const unknownLimits: CoreMemoryLimits = { declaredMaximumBytes: null, factoryMaximumBytes: null };
const coreLimits = new WeakMap<WebAssembly.Module, CoreMemoryLimits>();

export function recordProgramMemory(module: WebAssembly.Module, source: Uint8Array): void {
  const memory = memoryDeclarations(source);
  declareModuleMemory(module, source);
  declarations.set(module, memory);
  const limits = wasmMemoryLimits(source);
  const core = limits.length === 1 ? limits[0] : undefined;
  const declaredMaximumBytes = core?.maximum === undefined ? null : core.maximum * 65536;
  coreLimits.set(module, { declaredMaximumBytes, factoryMaximumBytes: core?.origin === "defined" ? declaredMaximumBytes : null });
}

/** Imported memory can have a tighter factory maximum; module declarations cannot establish it. */
export function programCoreMemoryLimits(module: WebAssembly.Module): CoreMemoryLimits {
  return coreLimits.get(module) ?? unknownLimits;
}

export function programMemory(module: WebAssembly.Module): readonly MemoryDeclaration[] {
  const memory = declarations.get(module);
  if (!memory) throw new TypeError("Compiled root requires source memory declarations");
  return memory;
}
