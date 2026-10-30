import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Hermes worker source guards pass against the original upstream fixtures", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-hermes-source-"));
  try {
    const source = resolve(import.meta.dir, "../crates/bunwasm-engine-hermes/src/source.rs");
    const binary = join(scratch, "hermes-source-tests");
    const compiled = Bun.spawnSync(["rustc", "--edition=2024", "--test", "-D", "warnings", source, "-o", binary], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
    const tested = Bun.spawnSync([binary, "--nocapture"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(tested.exitCode, tested.stderr.toString()).toBe(0);
    expect(tested.stdout.toString()).toContain("6 passed; 0 failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 65_000);
