import { expect, test } from "bun:test";
import { resolve } from "node:path";
const driver = resolve(import.meta.dir, "bun-runtime-proc-browser.ts");

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
