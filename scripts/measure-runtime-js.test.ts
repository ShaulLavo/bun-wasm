import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { firstFsSource, parseFirstFs, parseRuntimeScopes } from "./measure-runtime-js";

test("first-fs workload validates the actual module and cached identity", () => {
  const result = spawnSync(process.execPath, ["-e", firstFsSource], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const sample = parseFirstFs(result.stdout);
  expect(sample.firstRequireMs).toBeGreaterThanOrEqual(0);
  expect(sample.cachedRequireMs).toBeGreaterThanOrEqual(0);
});

test("missing, negative and non-finite measurements are rejected", () => {
  for (const stdout of ["", "runtime-js-first-fs {}", 'runtime-js-first-fs {"firstRequireMs":-1,"cachedRequireMs":0}', 'runtime-js-first-fs {"firstRequireMs":1e999,"cachedRequireMs":0}']) {
    expect(() => parseFirstFs(stdout)).toThrow();
  }
});

test("nested inclusive scopes are counted once and absence stays unknown", () => {
  expect(parseRuntimeScopes("unrelated stderr")).toBeNull();
  const summary = parseRuntimeScopes([
    '[bunwasm:runtime-js] engine=quickjs stage=factory-eval module="web" bytes=12 id=2 parent=1 elapsed_ns=30 status=ok scope=inclusive',
    '[bunwasm:runtime-js] engine=quickjs stage=bootstrap-execute module="bootstrap" bytes=0 id=1 parent=0 elapsed_ns=100 status=ok scope=inclusive',
  ].join("\n"));
  expect(summary?.rootInclusiveNs).toBe(100);
  expect(summary?.exclusiveByStage).toEqual({ "factory-eval": 30, "bootstrap-execute": 70 });
  expect(() => parseRuntimeScopes('[bunwasm:runtime-js] engine=q stage=factory-eval module="web" bytes=12 id=2 parent=1 elapsed_ns=30 scope=inclusive')).toThrow("Missing runtime scope parent");
});
