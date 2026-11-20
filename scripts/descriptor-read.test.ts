import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stableScratch } from "./stable-scratch.ts";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("production descriptor reads bound regular tails and preserve syscall behavior", () => {
  const scratch = stableScratch("descriptor-read");
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
