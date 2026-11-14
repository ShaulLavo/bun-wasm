import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertNativeGeneration, directoryIdentity, nativeGeneration } from "./spidermonkey-ordinary-ci.ts";
import { ordinaryFixtureCommand, ordinaryFixtures, ordinaryFixtureTimeout } from "./spidermonkey-ordinary-fixtures.ts";
import { discoverChecks, selectChecks } from "./test-checks.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch() { const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-ci-")); roots.push(root); return root; }

test("native generation changes with bytes, added and removed headers and symlink targets", () => {
  const root = scratch();
  const sysroot = join(root, "sysroot");
  mkdirSync(join(sysroot, "include"), { recursive: true });
  writeFileSync(join(root, "header"), "old");
  symlinkSync(join(root, "header"), join(sysroot, "include/export.h"));
  const original = nativeGeneration(directoryIdentity(sysroot));
  writeFileSync(join(root, "header"), "new");
  expect(nativeGeneration(directoryIdentity(sysroot))).not.toBe(original);
  writeFileSync(join(root, "header"), "old");
  expect(nativeGeneration(directoryIdentity(sysroot))).toBe(original);
  writeFileSync(join(sysroot, "include/new.h"), "new");
  expect(nativeGeneration(directoryIdentity(sysroot))).not.toBe(original);
  rmSync(join(sysroot, "include/new.h"));
  expect(nativeGeneration(directoryIdentity(sysroot))).toBe(original);
  rmSync(join(root, "header"));
  expect(() => directoryIdentity(sysroot)).toThrow();
});

test("an exact cache identity is required before retained objects can be verified", () => {
  const root = scratch();
  const identity = { profile: "split", config: "no-jit", headers: "first", tools: "pinned", sysroot: "ordinary" };
  writeFileSync(join(root, "ordinary-generation.json"), JSON.stringify(identity));
  expect(() => assertNativeGeneration(root, identity)).not.toThrow();
  for (const key of Object.keys(identity)) expect(() => assertNativeGeneration(root, { ...identity, [key]: "changed" })).toThrow(/generation changed/);
});

test("ordinary live gate has one runtime owner, no local selection and serial guest deadlines", () => {
  const checks = discoverChecks();
  const live = "scripts/spidermonkey-ordinary-fixtures.test.ts";
  expect(checks.filter(check => check.path === live)).toHaveLength(1);
  expect(selectChecks("runtime", checks)).toContain(live);
  expect(selectChecks("quality", checks)).not.toContain(live);
  expect(selectChecks("local-runtime", checks)).not.toContain(live);
  expect(readFileSync(resolve("scripts/spidermonkey-ordinary-fixtures.ts"), "utf8")).toContain("scripts/spidermonkey-engine-semantics.sh");
  expect(ordinaryFixtures).toHaveLength(20);
  expect(ordinaryFixtureTimeout).toBe(20 * 65_000 + 30_000);
});

test("the getter-loop fixture runs on both SpiderMonkey tiers through the ordinary gate", () => {
  const fixture = "spidermonkey-getter-loop";
  const checks = discoverChecks();
  // Its native manifest selects only QuickJS; SpiderMonkey reaches it through the ordinary list.
  expect(checks.filter(check => check.path === `tests/fixtures/${fixture}`)).toHaveLength(1);
  expect(selectChecks("runtime", checks)).toContain("scripts/spidermonkey-ordinary-fixtures.test.ts");
  const root = scratch();
  const path = join(root, "input");
  writeFileSync(path, "synthetic executable");
  chmodSync(path, 0o755);
  const env = { SPIDERMONKEY_WASM: path, BUN_WASM_LAUNCHER: path, BUN_WASM_SHELL: path, BUN_WASM_ENV_UTILITY: path };
  for (const tier of ["interp", "pbl"] as const) {
    const command = ordinaryFixtureCommand(root, env, tier);
    expect(command.slice(0, 8)).toEqual(["bash", join(root, "scripts/test.sh"), "--engine", "spidermonkey", "--wasm", path, "--tier", tier]);
    expect(command.filter(argument => argument === fixture)).toHaveLength(1);
  }
});

test("ordinary invocation passes explicit inputs once on either tier", () => {
  const root = scratch();
  const path = join(root, "input with spaces");
  writeFileSync(path, "synthetic executable");
  chmodSync(path, 0o755);
  const env = { SPIDERMONKEY_WASM: path, BUN_WASM_LAUNCHER: path, BUN_WASM_SHELL: path, BUN_WASM_ENV_UTILITY: path };
  for (const tier of ["interp", "pbl"] as const) {
    const command = ordinaryFixtureCommand(root, env, tier);
    expect(command).toEqual(["bash", join(root, "scripts/test.sh"), "--engine", "spidermonkey", "--wasm", path, "--tier", tier].concat(ordinaryFixtures));
  }
  expect(() => ordinaryFixtureCommand(root, { ...env, BUN_WASM_SHELL: "relative.wasm" }, "interp")).toThrow(/absolute/);
  expect(() => ordinaryFixtureCommand(root, { ...env, SPIDERMONKEY_WASM: join(root, "missing") }, "pbl")).toThrow();
});

test("workflow caches only native work and Cargo objects and exports after its single live gate", () => {
  const source = resolve(import.meta.dir, "..");
  const workflow = readFileSync(join(source, ".github/workflows/ci.yml"), "utf8");
  const rust = workflow.slice(workflow.indexOf("  rust:\n"), workflow.indexOf("\n  package:", workflow.indexOf("  rust:\n")));
  expect(rust.match(/bash scripts\/build-bun-core.sh/g)).toHaveLength(1);
  expect(rust.match(/bash scripts\/build-bun-spidermonkey.sh/g)).toHaveLength(1);
  expect(rust.match(/bun scripts\/test-checks.ts native\n/g)).toHaveLength(1);
  expect(rust.indexOf("Export the live-gated ordinary SpiderMonkey pair")).toBeGreaterThan(rust.indexOf("bun scripts/test-checks.ts native\n"));
  expect(rust).toContain("path: ${{ runner.temp }}/ordinary-spidermonkey-program/");
  expect(rust).toContain("Production SpiderMonkey adapter contains control symbols");
  const cacheKey = rust.split("\n").find(line => line.includes("key: spidermonkey-ordinary-v1-"));
  expect(cacheKey).toContain("steps.ordinary-spidermonkey-inputs.outputs.hash");
  expect(cacheKey).not.toContain("crates/**");
  expect(rust).not.toContain("path: ${{ runner.temp }}/ordinary-pair");
  expect(rust).not.toContain("path: ${{ runner.temp }}/ordinary-side\n");
});
