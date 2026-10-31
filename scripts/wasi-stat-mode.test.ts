import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

test("Preview1 stat modes present readable types without changing filesystem rights", () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-wasi-stat-"));
  try {
    const binary = join(scratch, "stat-mode-tests");
    const source = resolve(import.meta.dir, "../crates/bunwasm-runtime/src/natives/wasi_metadata.rs");
    const compiled = Bun.spawnSync(["rustc", "--edition=2024", "--test", source, "-o", binary], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(compiled.stderr.toString()).toBe("");
    expect(compiled.exitCode).toBe(0);
    const tested = Bun.spawnSync([binary, "--nocapture"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(tested.stderr.toString()).toBe("");
    expect(tested.exitCode).toBe(0);
    expect(tested.stdout.toString()).toContain("3 passed; 0 failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 65_000);
