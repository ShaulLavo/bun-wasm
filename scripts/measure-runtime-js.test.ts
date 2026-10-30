import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { selectChecks } from "./test-checks";
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

test("generic eval does not classify a user filename as runtime code", () => {
  const source = readFileSync(new URL("../crates/bunwasm-engine-quickjs/src/value_natives.rs", import.meta.url), "utf8");
  const start = source.indexOf('"evalScript"');
  const end = source.indexOf("\n    list.push((", start);
  const generic = source.slice(start, end);
  expect(generic).toContain("e.eval_script(&code, &filename, first_line)");
  expect(generic).not.toContain("eval_runtime_builtin");
});

test("the generated builtin loader alone selects trusted builtin evaluation", () => {
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bun_builtins.ts", import.meta.url), "utf8");
  const factory: unknown = runInNewContext(new Bun.Transpiler({ target: "browser" }).transformSync(`globalThis.runtimeFactory = ${source}`, "ts"));
  if (typeof factory !== "function") throw new Error("Missing actual runtime factory");
  const calls: unknown[][] = [];
  const code = "(intrinsics) => ({ loaded: true })";
  const loader: unknown = factory({
    bunBuiltinGlobals: globalThis,
    native: {
      bunBuiltinNames: () => ["fixture"],
      bunBuiltinSource: () => code,
      evalScript: () => { throw new Error("Generic user evaluator must not measure builtins"); },
      evalBuiltin: (...args: unknown[]) => { calls.push(args); return () => ({ loaded: true }); },
    },
  });
  if (!loader || typeof loader !== "object" || !("require" in loader) || typeof loader.require !== "function") throw new Error("Missing real builtin loader");
  const first: unknown = loader.require("fixture");
  expect(first).toEqual({ loaded: true });
  expect(loader.require("fixture")).toBe(first);
  expect(calls).toEqual([[code, "bun-builtin:fixture"]]);
});

test("runtime measurement tests have a blocking quality owner", () => {
  expect(selectChecks("quality")).toContain("scripts/measure-runtime-js.test.ts");
});
