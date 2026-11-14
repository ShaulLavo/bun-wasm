import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProducerEngines } from "./test-checks";

const target = join(import.meta.dir, "jsc-json-fast-controls.test.ts");
const collectionPattern = "^__jsc_registration_only__$";
const normalPattern = "^general depth limit remains authoritative$";
const longPattern = "^JSC slow-allocation GC pressure reaches the running guest$";
const flags = [{ value: undefined, label: "unset" }, { value: "0", label: "0" }, { value: "1", label: "1" }];

function collect(env: NodeJS.ProcessEnv, pattern?: string) {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-collection-"));
  try {
    const args = ["test", target].concat(pattern ? ["--test-name-pattern", pattern] : []);
    const result = spawnSync(process.execPath, args, {
      env: { ...env, BUN_WASM_LAUNCHER: join(scratch, "absent-launcher") },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.stderr).not.toContain("Unhandled error between tests");
    expect(result.stderr).not.toContain("Cannot call .if() on test.skip");
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const engines of [undefined, "jsc", "quickjs,jsc,browser", "quickjs,browser", "spidermonkey"]) {
  test.each(flags)(`actual JSC registration with engines=${engines ?? "default"} and long=$label`, ({ value: long }) => {
    const env = { ...process.env, BUN_WASM_CHECK_ENGINES: engines, BUN_WASM_JSON_LONG_STRESS: long };
    const selected = nativeProducerEngines(env).includes("jsc");
    const result = collect(env, selected ? collectionPattern : undefined);
    expect(result.status, result.stderr).toBe(selected ? 1 : 0);
    if (selected) {
      // Bun 1.4.4 returns 1 for an empty name-filter result even after successful collection.
      expect(result.stderr).toContain(`regex "${collectionPattern}" matched 0 tests`);
      expect(result.stderr).toContain("skipping 27 tests");
      return;
    }
    expect(result.stderr).toMatch(/0 pass\s+27 skip\s+0 fail/);
    expect(result.stderr).not.toContain("ENOENT");
  }, 90_000);
}

test.each(flags.slice(0, 2))("selected JSC keeps the long control opt-in with long=$label", ({ value: long }) => {
  const result = collect({ ...process.env, BUN_WASM_CHECK_ENGINES: "jsc", BUN_WASM_JSON_LONG_STRESS: long }, longPattern);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/0 pass\s+1 skip\s+0 fail/);
  expect(result.stderr).not.toContain("ENOENT");
}, 90_000);

test("explicitly selected JSC fails its existing normal control when the launcher is absent", () => {
  const result = collect({ ...process.env, BUN_WASM_CHECK_ENGINES: "jsc", BUN_WASM_JSON_LONG_STRESS: "1" }, normalPattern);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("ENOENT");
  expect(result.stderr).toContain("absent-launcher");
  expect(result.stderr).toMatch(/0 pass\s+26 filtered out\s+1 fail/);
}, 90_000);
