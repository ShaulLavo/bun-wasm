import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const catalog = join(import.meta.dir, "../crates/bunwasm-runtime/src/split_api.rs");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-split-api-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const coreOperations = "DESCRIBE, RESOLVE, PREPARE_SOURCE, POLYFILL_SOURCE, TAKE_TICK, FLUSH, WRAPPER_SOURCE, MAIN_PATH, LOWER_SCRIPT";
const engineOperations = "DESCRIBE, RESOLVE, PREPARE_SOURCE, POLYFILL_SOURCE, TAKE_TICK, FLUSH, WRAPPER_SOURCE, MAIN_PATH";

function compile(role: string, operations: string, ids: string, source = catalog) {
  const input = join(scratch, `${role}.rs`);
  const executable = join(scratch, role);
  writeFileSync(input, `#[path = ${JSON.stringify(source)}]\nmod split_api;\nfn main() {
    use split_api::*;
    assert_eq!([${operations}], [${ids}]);
  }\n`);
  const result = spawnSync("rustc", ["--edition=2024", "--crate-name", role, "-D", "warnings", input, "-o", executable], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...result, executable };
}

function verifyRole(role: string, operations: string, ids: string): void {
  const compiled = compile(role, operations, ids);
  expect(compiled.stderr).toBe("");
  expect(compiled.status).toBe(0);
  const run = spawnSync(compiled.executable, { encoding: "utf8", timeout: 5_000 });
  expect(run.error).toBeUndefined();
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
}

test("core catalog consumer preserves all operation IDs under -D warnings", () => {
  verifyRole("core_consumer", coreOperations, "1, 2, 3, 4, 5, 6, 7, 8, 9");
});

test("native-module engine catalog role need not send script-lowering requests", () => {
  verifyRole("engine_consumer", engineOperations, "1, 2, 3, 4, 5, 6, 7, 8");
});

test("the catalog exemption does not hide unused executable code", () => {
  const source = join(scratch, "catalog_with_code.rs");
  writeFileSync(source, readFileSync(catalog, "utf8") + "\nfn unexpected_live_code() {}\n");
  const compiled = compile("strict_catalog", coreOperations, "1, 2, 3, 4, 5, 6, 7, 8, 9", source);
  expect(compiled.status).not.toBe(0);
  expect(compiled.stderr).toContain("function `unexpected_live_code` is never used");
});
