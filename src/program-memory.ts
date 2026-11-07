import { declareModuleMemory, pages, type MemoryDeclaration } from "waffle";
import { wasmMemoryLimits } from "./engine-kind.ts";

export function memoryDeclarations(source: Uint8Array): readonly MemoryDeclaration[] {
  return wasmMemoryLimits(source).map(memory => memory.shared
    ? { kind: "shared", origin: memory.origin, initialPages: pages(memory.initial), maximumPages: pages(memory.maximum ?? 65_536) }
    : { kind: "private", origin: memory.origin, maximumPages: pages(memory.maximum ?? 65_536) });
}

const declarations = new WeakMap<WebAssembly.Module, readonly MemoryDeclaration[]>();

export function recordProgramMemory(module: WebAssembly.Module, source: Uint8Array): void {
  const memory = memoryDeclarations(source);
  declareModuleMemory(module, source);
  declarations.set(module, memory);
}

export function programMemory(module: WebAssembly.Module): readonly MemoryDeclaration[] {
  const memory = declarations.get(module);
  if (!memory) throw new TypeError("Compiled root requires source memory declarations");
  return memory;
}
