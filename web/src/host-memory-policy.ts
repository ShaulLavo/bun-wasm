import { BUN_MEMORY_GROUP_POLICY, type Engine } from "../../src/engine-kind";

const iphoneGroupPages = { quickjs: 12288, jsc: 20480, spidermonkey: 20480, browser: 32768 } as const;

export function memoryGroupPolicy(engine: Engine, userAgent: string) {
  if (!/\biPhone\b/.test(userAgent)) return BUN_MEMORY_GROUP_POLICY;
  const maximumPages = iphoneGroupPages[engine];
  if (maximumPages === BUN_MEMORY_GROUP_POLICY.maximumPages) return BUN_MEMORY_GROUP_POLICY;
  return { ...BUN_MEMORY_GROUP_POLICY, maximumPages, memberPages: Math.min(BUN_MEMORY_GROUP_POLICY.memberPages, maximumPages) };
}

export function nativeSharedMemoryEnvironment(engine: Engine, env: Record<string, string>, userAgent: string): Record<string, string> {
  if (engine === "browser" && /\biPhone\b/.test(userAgent)) return { ...env, BUN_WASM_IPHONE_NATIVE_MEMORY: "1" };
  if (!("BUN_WASM_IPHONE_NATIVE_MEMORY" in env)) return env;
  const current = { ...env };
  delete current.BUN_WASM_IPHONE_NATIVE_MEMORY;
  return current;
}
