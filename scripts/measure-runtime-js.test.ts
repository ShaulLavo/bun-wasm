import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { selectChecks } from "./test-checks";
import { firstFsSource, measurementArgs, parseFirstFs, parseRuntimeScopes, verifyMeasurementClosure } from "./measure-runtime-js";
import { launcherReceipt, producerArtifactPaths, producerEngines } from "./producer-closure.ts";

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

function closureFixture(run: (root: string, manifest: ReturnType<typeof writeClosureFixture>) => void): void {
  const root = mkdtempSync(join(tmpdir(), "runtime-measurement-"));
  try { run(root, writeClosureFixture(root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function writeClosureFixture(root: string) {
  const source = { head: "a".repeat(40), tree: "b".repeat(40) };
  for (const path of producerArtifactPaths("split")) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `synthetic identity fixture ${path}`, { mode: 0o700 });
  }
  const path = join(root, "launcher/bun-wasm"), receipt = `${path}.launcher.json`;
  const launcher = { path, receipt, ...launcherReceipt(path, source) };
  writeFileSync(receipt, JSON.stringify(launcher));
  const files = producerArtifactPaths("split").map(path => {
    const bytes = readFileSync(join(root, path));
    return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const manifest = { schema: 1, status: "reusable", profile: "split", engines: producerEngines("split"), source, launcher, files };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

test("measurement consumes the current complete closure and original launcher receipt without writing", () => {
  closureFixture((root, manifest) => {
    const before = readFileSync(join(root, "manifest.json"), "utf8");
    const closure = verifyMeasurementClosure(root);
    expect(closure.source).toEqual(manifest.source);
    expect(closure.artifacts).toHaveLength(manifest.files.length);
    expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe(before);
    expect(closure.launcher.sha256).toBe(manifest.launcher.artifact.sha256);
    writeFileSync(join(root, "dist/hermes-engine.wasm"), "changed companion");
    expect(() => verifyMeasurementClosure(root)).toThrow("Producer artifact changed");
  });
});

test("measurement rejects incomplete and mismatched producer identities before execution", () => {
  closureFixture((root, manifest) => {
    const save = (value: unknown) => writeFileSync(join(root, "manifest.json"), JSON.stringify(value));
    save({ ...manifest, files: manifest.files.slice(1) });
    expect(() => verifyMeasurementClosure(root)).toThrow("Missing producer manifest artifact");
    save({ ...manifest, source: { ...manifest.source, head: "c".repeat(40) } });
    expect(() => verifyMeasurementClosure(root)).toThrow("Launcher source");
    save({ ...manifest, profile: "shared-group" });
    expect(() => verifyMeasurementClosure(root)).toThrow("three-engine split closure");
    save({ ...manifest, launcher: { ...manifest.launcher, path: "/changed" } });
    expect(() => verifyMeasurementClosure(root)).toThrow("Manifest launcher differs");
    save(manifest);
    mkdirSync(join(root, ".producer-lock"));
    expect(() => verifyMeasurementClosure(root)).toThrow("Producer is active");
  });
});

test("measurement invocation follows canonical producer core paths and explicit guest opt-in", () => {
  expect(measurementArgs("/closure", "hermes", "1", false)).toEqual(["--wasm", "/closure/dist/bun-hermes.wasm", "--", "-e", "1"]);
  expect(measurementArgs("/closure", "quickjs", "1", true)).toEqual(["--wasm", "/closure/dist/bun.wasm", "--env", "BUN_WASM_MEASURE_RUNTIME_JS=1", "--", "-e", "1"]);
});
