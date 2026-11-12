import { recordProgramMemory } from "../../src/program-memory.ts";

export function fixtureModule(bytes: BufferSource): WebAssembly.Module {
  const module = new WebAssembly.Module(bytes);
  const source = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  recordProgramMemory(module, source);
  return module;
}
