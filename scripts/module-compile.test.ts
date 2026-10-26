import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHostEvaluation } from "./module-compile-runtime.ts";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-module-compile-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const factory = join(scratch, "module_compile.js");
const env = { ...process.env, BUNWASM_MODULE_COMPILE_FACTORY: factory };
beforeAll(() => {
  const result = Bun.spawnSync(["node", "--disable-warning=ExperimentalWarning", new URL("./transpile-runtime.ts", import.meta.url).pathname, new URL("../crates/bunwasm-runtime/src/js/module_compile.ts", import.meta.url).pathname, factory], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
});
const probe = new URL("./module-compile-probe.ts", import.meta.url).pathname;

for (const [engine, mode] of [["node", "native"], ["bun", "native"], ["node", "runtime"], ["node", "runtime-host"]] satisfies [string, string][]) {
  test(`${engine} ${mode} Module._compile and cached Next config contract`, () => {
    const result = Bun.spawnSync([engine].concat(engine === "node" ? ["--disable-warning=ExperimentalWarning"] : [], [probe, mode, scratch]), { stdout: "pipe", stderr: "pipe", env });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"nextConfig":"passed"');
  });
}

test("Next 15.5.6 and 16.4.3 use the same frozen config helper", () => {
  const source = readFileSync(new URL("./fixtures/module-compile/next-require-hook.txt", import.meta.url));
  expect(createHash("sha256").update(source).digest("hex")).toBe("9e9d766f499ebd65d83f8356c9345379d9c31c9be094c45145dc6433ca907540");
});

test("production loader executes the exact cached Next requireFromString helper", () => {
  const result = Bun.spawnSync(["node", "--disable-warning=ExperimentalWarning", probe, "runtime", scratch, "next"], { stdout: "pipe", stderr: "pipe", env });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("cached Next requireFromString passed");
});

for (const mode of ["native", "runtime", "runtime-host"]) {
  for (const contract of ["hashbang", "locations", "syntax"]) {
    test(`node ${mode} Module._compile ${contract} regression`, () => {
      const result = Bun.spawnSync(["node", "--disable-warning=ExperimentalWarning", probe, mode, scratch, contract], { stdout: "pipe", stderr: "pipe", env });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`${contract} contract passed`);
    });
  }
}

test("real Host evaluator isolates offsets, reuses filenames, and preserves ordinary mapping", () => {
  const calls: string[] = [];
  const native = {
    mapPosition(file: string, line: number, column: number): [number, number] {
      calls.push(file);
      return [line + 10, column + 1];
    },
  };
  const evaluator = productionHostEvaluation(native.mapPosition);
  Object.assign(native, evaluator);
  expect(evaluator.evalScript("42", "/first.cjs", -1)).toBe(42);
  expect(native.mapPosition("/first.cjs", 3, 7)).toEqual([1, 7]);
  expect(evaluator.evalScript("43", "/second.cjs", -1)).toBe(43);
  expect(native.mapPosition("/second.cjs", 5, 7)).toEqual([3, 7]);
  expect(native.mapPosition("/ordinary.cjs", 3, 7)).toEqual([13, 8]);
  expect(evaluator.evalScript("44", "/first.cjs", -1)).toBe(44);
  expect(native.mapPosition("/first.cjs", 3, 7)).toEqual([1, 7]);
  expect(evaluator.evalScript("45", "/first.cjs")).toBe(45);
  expect(native.mapPosition("/first.cjs", 3, 7)).toEqual([13, 8]);
  expect(native.mapPosition("/second.cjs", 5, 7)).toEqual([3, 7]);
  expect(calls).toEqual(["/ordinary.cjs", "/first.cjs"]);
});
