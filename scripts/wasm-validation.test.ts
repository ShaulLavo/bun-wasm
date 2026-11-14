import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function dependencyIdentities(path: string): Set<string> {
  const lock = Bun.TOML.parse(readFileSync(path, "utf8"));
  if (!("package" in lock) || !Array.isArray(lock.package)) throw new Error("Missing lock packages");
  return new Set(Array.from(lock.package, (entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry) || !("version" in entry)) throw new Error("Invalid lock package");
    return JSON.stringify([entry.name, entry.version, "source" in entry ? entry.source : null, "checksum" in entry ? entry.checksum : null]);
  }));
}

test("actual runtime validation avoids lazy body copies and compilation owns its input", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-validation-"));
  const target = join(scratch, "target");
  function cargo(args: string[]) {
    const result = Bun.spawnSync(["cargo"].concat(args), {
      cwd: scratch,
      env: { ...process.env, CARGO_TARGET_DIR: target, RUSTC_WRAPPER: "" },
      stdout: "pipe", stderr: "pipe", timeout: 120_000,
    });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  }
  try {
    mkdirSync(join(scratch, "src"));
    const natives = readFileSync(join(root, "crates/bunwasm-runtime/src/natives.rs"), "utf8");
    const start = natives.indexOf("#[derive(Default)]\npub struct Table");
    const end = natives.indexOf("/// Node's (code", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    writeFileSync(join(scratch, "Cargo.toml"), `[package]
name = "wasm-validation-source-unit"
version = "0.0.0"
edition = "2024"
[workspace]
[dependencies]
wasmi = { path = ${JSON.stringify(join(root, "third_party/wasmi"))}, default-features = false, features = ["std"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
wasmparser = "=0.228.0"
[patch.crates-io]
wasmi_core = { path = ${JSON.stringify(join(root, "third_party/wasmi_core"))} }
`);
    copyFileSync(join(root, "Cargo.lock"), join(scratch, "Cargo.lock"));
    writeFileSync(join(scratch, "src/main.rs"), `#![allow(dead_code, unexpected_cfgs)]
#[path = ${JSON.stringify(join(root, "crates/bunwasm-runtime/src/data.rs"))}] mod data;
mod natives {
use std::rc::Rc;
use crate::data::{Args, DataFn, NativeResult, Val};
${natives.slice(start, end)}
}
#[path = ${JSON.stringify(join(root, "crates/bunwasm-runtime/src/wasm.rs"))}] mod wasm;
` + readFileSync(join(root, "tests/wasm-validation/native.rs"), "utf8"));
    // Cargo prunes the copied workspace lock; every surviving dependency must retain its identity.
    cargo(["metadata", "--offline", "--format-version", "1"]);
    const original = dependencyIdentities(join(root, "Cargo.lock"));
    original.add(JSON.stringify(["wasm-validation-source-unit", "0.0.0", null, null]));
    for (const identity of dependencyIdentities(join(scratch, "Cargo.lock"))) expect(original).toContain(identity);
    console.log(cargo(["run", "--locked", "--offline", "-j", "2"]));
    console.log(cargo(["clippy", "--locked", "--offline", "-j", "2", "--all-targets", "--no-deps", "--", "-Dwarnings"]));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
