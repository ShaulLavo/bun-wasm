import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("native filesystem errors retain errno identity, Node messages, and ErrorKind fallbacks", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-native-errno-"));
  try {
    const root = resolve(import.meta.dir, "..");
    const source = readFileSync(join(root, "crates/bunwasm-runtime/src/natives.rs"), "utf8");
    const start = source.indexOf("fn errno_info(");
    const end = source.indexOf("fn millis(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const input = `#![feature(io_error_more)]\n#![allow(dead_code, unexpected_cfgs)]
#[path=${JSON.stringify(join(root, "crates/bunwasm-runtime/src/data.rs"))}] mod data;
use data::NativeError;
use std::io;
${source.slice(start, end)}
${readFileSync(join(import.meta.dir, "fixtures/native-errno-control.rs"), "utf8")}`;
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, "src/main.rs"), input);
    writeFileSync(join(scratch, "Cargo.toml"), `[package]\nname="native-errno-fidelity-control"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nlibc={path=${JSON.stringify(join(root, "third_party/libc"))}}\n`);
    const native = Bun.spawnSync(["cargo", "run", "--quiet", "--offline", "--manifest-path", join(scratch, "Cargo.toml"), "-j", "2"], {
      env: { ...process.env, CARGO_TARGET_DIR: join(scratch, "target") },
      stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(native.exitCode, native.stderr.toString()).toBe(0);
    const node = Bun.spawnSync(["node", "--expose-internals", fileURLToPath(new URL("./fixtures/native-errno-node.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(node.exitCode, node.stderr.toString()).toBe(0);
    expect(native.stdout.toString()).toBe(node.stdout.toString());
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 75_000);
