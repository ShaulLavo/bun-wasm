import type { NodeWasiImports } from "./node-process.ts";

export function installCliFetch(imports: NodeWasiImports, instance: () => WebAssembly.Instance, wake?: Int32Array): {
  call(slot: number, a: number, b: number, c: number, d: number): number;
  install(): void;
  dispose(): void;
};
