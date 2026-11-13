import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

test("Rust rejects an empty filesystem path without normalizing valid paths", () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-empty-native-"));
  try {
    const binary = join(scratch, "fs-path-tests");
    const source = new URL("../crates/bunwasm-runtime/src/natives/fs_path.rs", import.meta.url).pathname;
    const compiled = Bun.spawnSync(["rustc", "--edition=2024", "--test", source, "-o", binary], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(compiled.stderr.toString()).toBe("");
    expect(compiled.exitCode).toBe(0);
    const tested = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(tested.stderr.toString()).toBe("");
    expect(tested.exitCode).toBe(0);
    expect(tested.stdout.toString()).toContain("2 passed; 0 failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
