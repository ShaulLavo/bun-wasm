import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTemporaryPaths, ciTemporarySources, temporaryPathFailures } from "./ci-temp-guard";
import { automaticChecks, discoverChecks, selectChecks } from "./test-checks";

const root = join(import.meta.dir, "..");
const failures = (text: string) => temporaryPathFailures("control.ts", text);

test.each([
  'const scratch = mkdtempSync("/work/tmp/bun-wasm-next01-argv-");',
  'const directory = mkdtempSync("/work/tmp/bun-wasm-vinext-regression-");',
])("rejects the exact NEXT01 and vinext hosted failures: %s", text => {
  expect(failures(text)).toHaveLength(1);
  expect(failures(text)[0]).toContain("control.ts:1:");
});

test.each([
  'import { mkdtempSync as scratch } from "node:fs"; scratch("/work/tmp/test-");',
  'const { mkdtemp: scratch } = require("fs/promises"); await scratch("/home/runner/test-");',
  'fs.mkdtempSync("/work/tmp/test-");',
  'fs.mkdtemp("/work/tmp/test-", callback);',
  'await fs.promises.mkdtemp("/work/tmp/test-");',
  'await mkdtemp("/work/tmp/test-");',
  'require("node:fs/promises")["mkdtemp"]("/work/tmp/test-");',
  'fs.mkdtempDisposableSync("/work/tmp/test-");',
  'await fs.mkdtempDisposable("/work/tmp/test-");',
  'mkdtempSync(`/work/tmp/test-${process.pid}-`);',
  'mkdtempSync("/work/tmp/test-" + process.pid);',
  'mkdtempSync(join("/work/tmp", "test-"));',
  'mkdtempSync(resolve("/Users/developer/tmp", "test-"));',
  'mkdtempSync("C:\\\\Users\\\\developer\\\\Temp\\\\test-");',
])("rejects literal temporary prefixes across fs call forms: %s", text => {
  expect(failures(text)).toHaveLength(1);
});

test.each([
  'mkdtempSync(join(tmpdir(), "bun-wasm-next01-argv-"));',
  'await fs.promises.mkdtemp(join(process.env.TMPDIR!, "test-"));',
  'mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "test-"));',
  'fs.mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "test-"), callback);',
  'const source = "/work/projects/bun-wasm/tests/fixture.ts"; expect(output).toBe("/work/tmp/fixture");',
  'const source = `mkdtempSync("/work/tmp/fixture-")`; expect(source).toContain("/work/tmp");',
  'writeFileSync("/work/reports/result.json", data); mkdirSync("/work/output");',
  '// mkdtempSync("/work/tmp/comment-")\nmkdtempSync(join(tmpdir(), "test-"));',
])("accepts configured roots and fixture/output strings: %s", text => {
  expect(failures(text)).toEqual([]);
});

test("blocking quality discovery owns this guard and every selected test is audited", () => {
  expect(selectChecks("quality")).toContain("scripts/ci-temp-guard.test.ts");
  const sources = new Set(ciTemporarySources());
  const selected = discoverChecks().filter(check => check.owner !== "native").map(check => check.path)
    .concat(automaticChecks().map(check => check.path));
  for (const path of selected) expect(sources.has(path)).toBe(true);
  expect(sources.has("scripts/app-matrix/next-acceptance-fixture.ts")).toBe(true);
  expect(Array.from(sources).some(path => path.includes("node_modules"))).toBe(false);
});

test("actual CI-discovered test and imported setup sources have no hard-coded temporary directories", () => {
  expect(auditTemporaryPaths()).toEqual([]);
});

test("real selected NEXT01 source turns RED when its original argument is restored", () => {
  const path = "scripts/app-matrix/next-acceptance.test.ts";
  const source = readFileSync(join(root, path), "utf8");
  const original = source.replace('join(tmpdir(), "bun-wasm-next01-argv-")', '"/work/tmp/bun-wasm-next01-argv-"');
  expect(original).not.toBe(source);
  expect(temporaryPathFailures(path, source)).toEqual([]);
  expect(temporaryPathFailures(path, original)).toHaveLength(1);
});


test("discovery audits imported setup and reruns GREEN after portable roots replace both regressions", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-ci-temp-guard-"));
  try {
    for (const folder of ["checks", "scripts", "tests/package", "web/tests"]) mkdirSync(join(directory, folder), { recursive: true });
    writeFileSync(join(directory, "checks/quality-example.json"), JSON.stringify({ owner: "quality", path: "scripts/example.test.ts" }));
    const entry = 'import "./setup"; const scratch = mkdtempSync("/work/tmp/bun-wasm-next01-argv-");';
    const setup = 'const directory = mkdtempSync("/work/tmp/bun-wasm-vinext-regression-");';
    writeFileSync(join(directory, "scripts/example.test.ts"), entry);
    writeFileSync(join(directory, "scripts/setup.ts"), setup);
    expect(ciTemporarySources(directory)).toEqual(["scripts/example.test.ts", "scripts/setup.ts"]);
    expect(auditTemporaryPaths(directory)).toHaveLength(2);
    writeFileSync(join(directory, "scripts/example.test.ts"), entry.replace('"/work/tmp/bun-wasm-next01-argv-"', 'join(tmpdir(), "bun-wasm-next01-argv-")'));
    writeFileSync(join(directory, "scripts/setup.ts"), setup.replace('"/work/tmp/bun-wasm-vinext-regression-"', 'join(process.env.TMPDIR!, "bun-wasm-vinext-regression-")'));
    expect(auditTemporaryPaths(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
