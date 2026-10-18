import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { runtimeProcFixture } from "./runtime-proc-fixtures";
const driver = resolve(import.meta.dir, "bun-runtime-proc-browser.ts");

test("explicit artifact must actually import the complete direct process ABI", () => {
  // Own only this tiny fixture directory; teardown precedes the first file/process setup.
  const base = process.env.RUNNER_TEMP ?? tmpdir();
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

for (const missing of ["job_of", "signal", "start_status", "access_start", "access_take", "access_cancel"]) test(`explicit artifact must directly import runtime_proc.${missing}`, () => {
  const names = ["spawn", "pipe", "read", "write", "wait", "wait_job", "kill", "kill_job", "poll", "job_of", "signal", "start_status", "access_start", "access_take", "access_cancel"].filter(name => name !== missing);
  // Original import-only module: admission inspects imports, never executes these stubs.
  const leb = (value: number): number[] => value < 128 ? [value] : [value % 128 + 128].concat(leb(Math.floor(value / 128)));
  const text = (value: string) => leb(value.length).concat(Array.from(new TextEncoder().encode(value)));
  const imports = leb(names.length).concat(names.flatMap(name => text("runtime_proc").concat(text(name), [0, 0])));
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2].concat(leb(imports.length), imports));
  expect(WebAssembly.validate(bytes)).toBe(true);
  const base = process.env.RUNNER_TEMP ?? tmpdir();
  const directory = mkdtempSync(join(base, "bun-wasm-bun-runtime-artifact-control-"));
  try {
    const artifact = join(directory, `missing-${missing}.wasm`);
    writeFileSync(artifact, bytes);
    const result = Bun.spawnSync({ cmd: [process.execPath, driver, "--check-artifact"],
      env: { ...process.env, BUN_WASM_RUNTIME_PROC_ARTIFACT: artifact }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(`matching rebuilt guest must directly import runtime_proc.${missing}`);
    expect(new TextDecoder().decode(result.stdout)).not.toContain('"resources"');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  expect(existsSync(directory)).toBe(false);
});

for (const artifact of ["", "dist/bun-browser.wasm"]) test(`real Bun acceptance refuses ${artifact || "missing"} artifact before browser setup`, () => {
  const result = Bun.spawnSync({ cmd: [process.execPath, driver],
    env: { ...process.env, BUN_WASM_RUNTIME_PROC_ARTIFACT: artifact }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("BUN_WASM_RUNTIME_PROC_ARTIFACT must name the explicit absolute matching rebuilt Bun artifact for the selected engine");
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
