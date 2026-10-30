import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("production recursive mkdir preserves directory, symlink, and first-created semantics", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-mkdir-source-"));
  try {
    const root = resolve(import.meta.dir, "..");
    const source = readFileSync(join(root, "crates/bunwasm-runtime/src/natives.rs"), "utf8");
    const start = source.indexOf("fn mkdir_recursive(");
    const end = source.indexOf("\nfn install_fs(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const tests = join(root, "crates/bunwasm-runtime/src/natives/mkdir_tests.rs");
    writeFileSync(join(scratch, "control.rs"), `use std::{fs, io, path::Path, time::{SystemTime, UNIX_EPOCH}};
${source.slice(start, end)}
#[path = ${JSON.stringify(tests)}] mod mkdir_tests;
`);
    const build = Bun.spawnSync(["rustc", "--edition", "2024", "--test", join(scratch, "control.rs"), "-o", join(scratch, "control")], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([join(scratch, "control"), "--nocapture"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 45_000);
