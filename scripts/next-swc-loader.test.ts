import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

let scratch: string | undefined;
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
beforeAll(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-next-swc-unit-"));
});

test("Next SWC package adapter resolves installed backends without changing other imports", () => {
  if (!scratch) throw new Error("Missing test directory");
  const source = resolve(import.meta.dir, "../crates/bunwasm-runtime/src/next_swc.rs");
  const binary = join(scratch, "next-swc-tests");
  const compiled = Bun.spawnSync(["rustc", "--edition=2024", "--test", source, "-o", binary], {
    stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  expect(compiled.stderr.toString()).toBe("");
  expect(compiled.exitCode).toBe(0);
  const tested = Bun.spawnSync([binary, "--nocapture"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(tested.stdout.toString()).toContain("9 passed; 0 failed");
  expect(tested.exitCode).toBe(0);
}, 65_000);
