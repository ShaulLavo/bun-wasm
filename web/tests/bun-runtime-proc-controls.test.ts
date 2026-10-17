import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { runtimeProcFixture } from "./runtime-proc-fixtures";
const driver = resolve(import.meta.dir, "bun-runtime-proc-browser.ts");

test("explicit artifact must actually import the complete direct process ABI", () => {
  // Own only this tiny fixture directory; teardown precedes the first file/process setup.
  const base = process.env.RUNNER_TEMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const directory = mkdtempSync(join(base, "bun-wasm-bun-runtime-artifact-control-"));
  try {
    const artifact = join(directory, "not-the-bun-guest.wasm");
    writeFileSync(artifact, runtimeProcFixture());
    const result = Bun.spawnSync({ cmd: [process.execPath, driver, "--check-artifact"],
      env: { ...process.env, BUN_WASM_RUNTIME_PROC_ARTIFACT: artifact }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("matching rebuilt guest must directly import runtime_proc.wait_job");
    expect(new TextDecoder().decode(result.stdout)).not.toContain('"resources"');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  expect(existsSync(directory)).toBe(false);
});

for (const artifact of ["", "dist/bun-browser.wasm"]) test(`real Bun acceptance refuses ${artifact || "missing"} artifact before browser setup`, () => {
  const result = Bun.spawnSync({ cmd: [process.execPath, driver],
    env: { ...process.env, BUN_WASM_RUNTIME_PROC_ARTIFACT: artifact }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("BUN_WASM_RUNTIME_PROC_ARTIFACT must name the explicit absolute matching rebuilt Bun browser artifact");
  expect(new TextDecoder().decode(result.stdout)).not.toContain('"resources"');
});

test("real Bun acceptance refuses a missing explicit artifact without building or downloading", () => {
  const artifact = resolve(import.meta.dir, "bun-runtime-proc-deliberately-absent.wasm");
  const result = Bun.spawnSync({ cmd: [process.execPath, driver],
    env: { ...process.env, BUN_WASM_RUNTIME_PROC_ARTIFACT: artifact }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain(`explicit Bun artifact does not exist: ${artifact}`);
  expect(new TextDecoder().decode(result.stdout)).not.toContain('"resources"');
});
