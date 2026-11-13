import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("production descriptor reads bound regular tails and preserve syscall behavior", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-descriptor-read-"));
  try {
    const root = resolve(import.meta.dir, "..");
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, "src/lib.rs"), `#![allow(dead_code)]\n#[path=${JSON.stringify(join(root, "crates/bunwasm-runtime/src/natives/descriptor_read.rs"))}] mod descriptor_read;`);
    writeFileSync(join(scratch, "Cargo.toml"), `[package]\nname="descriptor-read-control"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nlibc={path=${JSON.stringify(join(root, "third_party/libc"))}}\n`);
    const result = Bun.spawnSync(["cargo", "test", "--offline", "--manifest-path", join(scratch, "Cargo.toml"), "-j", "2", "--", "--nocapture"], {
      env: { ...process.env, CARGO_TARGET_DIR: join(scratch, "target") },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(result.exitCode, result.stderr.toString().concat(result.stdout.toString())).toBe(0);
    console.log(result.stdout.toString());
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 75_000);
