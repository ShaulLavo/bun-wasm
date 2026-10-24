import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { automaticChecks, checkCommand, discoverChecks, selectChecks, runCheck, checkBatches } from "./test-checks";
import { migrationBase } from "./migrations/split-bun-patches";
import { oldSelections, proveCheckMigration } from "./migrations/discover-checks";

const root = resolve(import.meta.dir, "..");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "bun-wasm-check-discovery-"));
  scratch.push(path);
  mkdirSync(join(path, "checks"));
  mkdirSync(join(path, "scripts"));
  writeFileSync(join(path, "scripts/example.test.ts"), "");
  writeFileSync(join(path, "checks/runtime-example.json"), JSON.stringify({ owner: "runtime", path: "scripts/example.test.ts", localRuntime: true }));
  return path;
}

function manifest(directory: string, fields: unknown, filename = "runtime-example.json") {
  writeFileSync(join(directory, "checks", filename), JSON.stringify(fields));
}

test("immutable old selections match the discovered sets, with seven overlapping probes assigned only to Web", () => {
  const proof = proveCheckMigration();
  expect(proof.deduplicated).toHaveLength(7);
  const original = oldSelections();
  const historical = new Set(Object.values(original).flat());
  expect(selectChecks("local-runtime").filter(path => historical.has(path))).toEqual(original.runtime.toSorted());
  const paths = proof.explicit.map(check => check.path).concat(proof.automatic.map(check => check.path));
  expect(new Set(paths).size).toBe(paths.length);
});

test("discovery is sorted and adding a feature needs no shared command edit", () => {
  const directory = fixture();
  writeFileSync(join(directory, "scripts/another.test.ts"), "");
  manifest(directory, { owner: "runtime", path: "scripts/another.test.ts", localRuntime: true }, "runtime-another.json");
  expect(selectChecks("runtime", discoverChecks(directory))).toEqual(["scripts/another.test.ts", "scripts/example.test.ts"]);
  expect(() => selectChecks("web", discoverChecks(directory))).toThrow("Missing checks");
});

test("a later hostname feature keeps the formats limit under its existing single owner", () => {
  const directory = fixture();
  for (const path of ["formats-input-limit", "hostname-normalization"]) {
    writeFileSync(join(directory, `scripts/${path}.test.ts`), "");
    manifest(directory, { owner: "runtime", path: `scripts/${path}.test.ts`, localRuntime: true }, `runtime-${path}.json`);
  }
  expect(selectChecks("runtime", discoverChecks(directory))).toEqual(["scripts/example.test.ts", "scripts/formats-input-limit.test.ts", "scripts/hostname-normalization.test.ts"]);
  expect(discoverChecks().filter(check => check.path === "scripts/formats-input-limit.test.ts")).toEqual([
    { owner: "runtime", path: "scripts/formats-input-limit.test.ts", localRuntime: true, batch: "default" },
  ]);
});

test.each([
  { owner: "runtime", path: "scripts/../outside.test.ts" },
  { owner: "runtime", path: "/tmp/outside.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts;exit 0" },
  { owner: "runtime", path: "scripts/*.test.ts" },
  { owner: "runtime", path: "web/tests/example.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts", command: "true" },
  { owner: "unknown", path: "scripts/example.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts", localRuntime: "true" },
  { path: "scripts/example.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts", batch: "10-web" },
])("unsafe or malformed manifest is rejected: %j", fields => {
  const directory = fixture();
  manifest(directory, fields);
  expect(() => discoverChecks(directory)).toThrow();
});

test("missing, duplicate and linked inputs fail closed", () => {
  const directory = fixture();
  manifest(directory, { owner: "web", path: "scripts/example.test.ts" }, "web-duplicate.json");
  expect(() => discoverChecks(directory)).toThrow("Duplicate check owner");
  rmSync(join(directory, "checks/web-duplicate.json"));
  rmSync(join(directory, "scripts/example.test.ts"));
  expect(() => discoverChecks(directory)).toThrow();
  symlinkSync(join(root, "scripts/test-checks.test.ts"), join(directory, "scripts/example.test.ts"));
  expect(() => discoverChecks(directory)).toThrow("Unsafe linked check");
});

test("runner uses argv, no-build fixtures and failure propagation, not a shell command string", () => {
  expect(checkCommand("runtime", ["scripts/example.test.ts"])).toEqual(["bun", "test", join(root, "scripts/example.test.ts")]);
  expect(checkCommand("native", ["tests/fixtures/node-misc"])).toEqual(["bash", join(root, "scripts/test.sh"), "--no-build", "node-misc"]);
  const result = spawnSync("bun", ["./test-checks.ts", "invalid-owner"], { cwd: import.meta.dir, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Unknown check owner");
  const source = readFileSync(join(root, "scripts/test-checks.ts"), "utf8");
  expect(runCheck(["bun", "-e", "process.exit(23)"])).toBe(23);
  expect(source).toContain('BUN_WASM_CI_CHECKS: "1"');
});

function testFiles(folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const path = `${folder}/${entry.name}`;
    return entry.isDirectory() ? testFiles(path) : /\.test\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}

test("new script tests need an owner; existing non-CI probes remain outside the blocking selection", () => {
  const before = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", migrationBase], { cwd: root, encoding: "utf8" }).split("\n"));
  const owned = new Set(discoverChecks().map(check => check.path).concat(automaticChecks().map(check => check.path)));
  for (const path of testFiles("scripts")) expect(before.has(path) || owned.has(path)).toBe(true);
});

test("selected tests cannot import hidden test barrels that give a fixture a second owner", () => {
  const paths = discoverChecks().filter(check => check.owner !== "native").map(check => check.path).concat(automaticChecks().map(check => check.path));
  for (const path of paths) expect(readFileSync(join(root, path), "utf8")).not.toMatch(/^import\s+(?:.*from\s+)?["'][^"']+\.test\.[cm]?[jt]s["']/m);
});

test("each discovery group retains one command owner and browser deadlines stay outside discovery", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  for (const owner of ["native", "package-extra", "cmake"]) expect(workflow.match(new RegExp(`bun scripts/test-checks\\.ts ${owner}\\n`, "g"))).toHaveLength(1);
  const web = readFileSync(join(root, "scripts/test-web-host.sh"), "utf8");
  expect(web.match(/bun \.\.\/scripts\/test-checks.ts web\n/g)).toHaveLength(1);
  expect(web).toContain("browser_test bun ../scripts/test-checks.ts web-browser");
  const runtime = readFileSync(join(root, "scripts/check-runtime.sh"), "utf8");
  expect(runtime).toContain('bun "$root/scripts/test-checks.ts" runtime');
  expect(runtime).toContain('bun "$root/scripts/test-checks.ts" local-runtime');
  expect(runtime.indexOf('BUN_WASM_CI_CHECKS')).toBeLessThan(runtime.indexOf('"$root/web/node_modules/.bin/tsc" -p'));
});

test("Web subprocess boundaries and fail-fast order are preserved by manifest batches", () => {
  const proof = proveCheckMigration();
  expect(checkBatches("web")).toEqual(proof.webBatches);
  expect(checkBatches("local-runtime")).toEqual([selectChecks("local-runtime")]);
  expect(proof.webBatches.map(paths => paths.length)).toEqual([10, 2, 3]);
});
