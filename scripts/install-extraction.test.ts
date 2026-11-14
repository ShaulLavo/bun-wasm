import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("installer extraction reuses parent directories and preserves archive behavior", () => {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-install-extraction-"));
  try {
    const source = readFileSync(join(root, "crates/bunwasm-runtime/src/install/io.rs"), "utf8");
    const start = source.indexOf("type ArchiveEntry");
    const end = source.indexOf("\n#[cfg(test)]", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, "src/extraction.rs"), `use std::{collections::BTreeSet, fs, io::{Read, Write}, path::{Component, Path, PathBuf}};
use serde_json::Value;
type Result<T> = std::result::Result<T, String>;
const LIMIT: usize = 256 * 1024 * 1024;
${source.slice(start, end).replaceAll("fs::create_dir_all(", "crate::create_dir_all(")}`);
    copyFileSync(join(root, "crates/bunwasm-runtime/fixtures/install-extraction.rs"), join(scratch, "src/main.rs"));
    writeFileSync(join(scratch, "Cargo.toml"), `[package]
name="install-extraction-control"
version="0.0.0"
edition="2024"
[dependencies]
serde_json="1"
tar={version="0.4",default-features=false}
flate2={version="1",default-features=false,features=["rust_backend"]}
[patch.crates-io]
tar={path=${JSON.stringify(join(root, "third_party/tar"))}}
`);
    copyFileSync(join(root, "Cargo.lock"), join(scratch, "Cargo.lock"));
    const result = Bun.spawnSync(["cargo", "run", "--offline", "--release", "--manifest-path", join(scratch, "Cargo.toml"), "-j", "2", "--", scratch], {
      env: { ...process.env, CARGO_TARGET_DIR: join(scratch, "target") }, stdout: "pipe", stderr: "pipe", timeout: 90_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 100_000);
