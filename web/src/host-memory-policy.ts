import { BUN_MEMORY_GROUP_POLICY, type Engine } from "../../src/engine-kind";

export function memoryGroupPolicy(engine: Engine, userAgent: string) {
  if (engine !== "quickjs" || !/\biPhone\b/.test(userAgent)) return BUN_MEMORY_GROUP_POLICY;
  return { ...BUN_MEMORY_GROUP_POLICY, maximumPages: 12288, memberPages: 12288 };
}

export function nativeSharedMemoryEnvironment(engine: Engine, env: Record<string, string>, userAgent: string): Record<string, string> {
  if (engine === "browser" && /\biPhone\b/.test(userAgent)) return { ...env, BUN_WASM_IPHONE_NATIVE_MEMORY: "1" };
  if (!("BUN_WASM_IPHONE_NATIVE_MEMORY" in env)) return env;
  const current = { ...env };
  delete current.BUN_WASM_IPHONE_NATIVE_MEMORY;
  return current;
}
