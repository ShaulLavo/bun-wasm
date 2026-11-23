import { expect, test } from "bun:test";
import { memoryGroupPolicy, nativeSharedMemoryEnvironment } from "../web/src/host-memory-policy";
import { BUN_MEMORY_GROUP_POLICY } from "../src/engine-kind";

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1";
const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.4 Safari/605.1.15";

// Complete nine-phase Chrome workflows on 587c2c69c; Nuxt's Nitro dev render and build set the QuickJS peak.
const quickjsMeasuredBackingBytes = { angular: 470_089_728, "vite-react": 568_131_584, nuxt: 1_091_502_080 };

test("iPhone QuickJS groups have growth room above every measured shared-group framework workload", () => {
  const policy = memoryGroupPolicy("quickjs", iphone);
  expect(policy.maximumPages * 65536).toBe(1280 << 20);
  expect(policy.memberPages).toBe(BUN_MEMORY_GROUP_POLICY.memberPages);
  expect(policy.memberPages).toBeLessThanOrEqual(policy.maximumPages);
  expect(policy.stackBytes).toBe(BUN_MEMORY_GROUP_POLICY.stackBytes);
  for (const bytes of Object.values(quickjsMeasuredBackingBytes)) expect(policy.maximumPages * 65536).toBeGreaterThan(bytes * 1.2);
  expect(memoryGroupPolicy("quickjs", desktop)).toBe(BUN_MEMORY_GROUP_POLICY);
});

const jscMeasuredBackingBytes = { angular: 760_545_280, "vite-react": 996_737_024, nuxt: 1_414_397_952 };
const spiderMonkeyMeasuredBackingBytes = { angular: 1_033_568_256, nuxt: 1_358_168_064 };

test.each([
  ["jsc", jscMeasuredBackingBytes],
  ["spidermonkey", spiderMonkeyMeasuredBackingBytes],
] as const)("iPhone %s backing has growth room above Nuxt while retaining the original member allowance", (engine, measured) => {
  const policy = memoryGroupPolicy(engine, iphone);
  expect(policy.maximumPages * 65536).toBe(1536 << 20);
  expect(policy.memberPages).toBe(BUN_MEMORY_GROUP_POLICY.memberPages);
  expect(policy.memberPages).toBeLessThanOrEqual(policy.maximumPages);
  for (const bytes of Object.values(measured)) expect(policy.maximumPages * 65536).toBeGreaterThan(bytes * 1.13);
  expect(memoryGroupPolicy(engine, desktop)).toBe(BUN_MEMORY_GROUP_POLICY);
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
