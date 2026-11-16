import { expect, test } from "bun:test";
import { memoryGroupPolicy, nativeSharedMemoryEnvironment } from "../web/src/host-memory-policy";
import { BUN_MEMORY_GROUP_POLICY } from "../src/engine-kind";

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1";
const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.4 Safari/605.1.15";

test("iPhone QuickJS groups have growth room above both measured framework workloads", () => {
  const policy = memoryGroupPolicy("quickjs", iphone);
  expect(policy.maximumPages * 65536).toBe(768 << 20);
  expect(policy.memberPages).toBeLessThanOrEqual(policy.maximumPages);
  expect(policy.stackBytes).toBe(BUN_MEMORY_GROUP_POLICY.stackBytes);
  expect(memoryGroupPolicy("quickjs", desktop)).toBe(BUN_MEMORY_GROUP_POLICY);
});

test("iPhone native tools get the bounded-memory environment and keep caller variables", () => {
  const env = { PATH: "/bin" };
  expect(nativeSharedMemoryEnvironment("browser", env, iphone)).toEqual({ PATH: "/bin", BUN_WASM_IPHONE_NATIVE_MEMORY: "1" });
  expect(env).toEqual({ PATH: "/bin" });
});

test("desktop and group-backed tools keep their original environment", () => {
  const env = { PATH: "/bin" };
  expect(nativeSharedMemoryEnvironment("browser", env, desktop)).toBe(env);
  for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) expect(nativeSharedMemoryEnvironment(engine, env, iphone)).toBe(env);
});

test("a child changing engine cannot inherit the native-only tool limit", () => {
  const env = { PATH: "/bin", BUN_WASM_IPHONE_NATIVE_MEMORY: "1" };
  expect(nativeSharedMemoryEnvironment("quickjs", env, iphone)).toEqual({ PATH: "/bin" });
  expect(nativeSharedMemoryEnvironment("browser", env, desktop)).toEqual({ PATH: "/bin" });
  expect(env.BUN_WASM_IPHONE_NATIVE_MEMORY).toBe("1");
});
