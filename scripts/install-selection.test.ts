import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native installer selection reuses Bun queries without changing the version scan", () => {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-install-selection-"));
  try {
    const source = readFileSync(join(root, "crates/bunwasm-glue/src/bun_native.rs"), "utf8");
    const start = source.indexOf("unsafe fn bytes<");
    const end = source.indexOf('#[unsafe(no_mangle)]\n#[linkage = "weak"]\nunsafe extern "C" fn highway_memrmem', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, "src/glue.rs"), source.slice(start, end));
    const selection = readFileSync(join(root, "crates/bunwasm-runtime/src/install/resolve/selection.rs"), "utf8");
    writeFileSync(join(scratch, "src/selection.rs"), selection.replaceAll("query::parse(", "({ crate::record_parse(); query::parse })("));
    const control = readFileSync(join(root, "crates/bunwasm-runtime/fixtures/install-selection.rs"), "utf8");
    writeFileSync(join(scratch, "src/main.rs"), `#![feature(linkage)]
#[allow(dead_code)] mod glue;
mod selection;
${control}`);
    writeFileSync(join(scratch, "Cargo.toml"), `[package]
name="install-selection-control"
version="0.0.0"
edition="2024"
[dependencies]
bun_semver={path=${JSON.stringify(join(root, "vendor/bun/src/semver"))}}
serde_json={version="1",features=["preserve_order"]}
[patch.crates-io]
libc={path=${JSON.stringify(join(root, "third_party/libc"))}}
[profile.release]
opt-level="s"
lto="thin"
codegen-units=4
panic="abort"
`);
    copyFileSync(join(root, "Cargo.lock"), join(scratch, "Cargo.lock"));
    const result = Bun.spawnSync(["cargo", "run", "--offline", "--release", "--manifest-path", join(scratch, "Cargo.toml"), "-j", "2"], {
      env: { ...process.env, CARGO_TARGET_DIR: join(scratch, "target") }, stdout: "pipe", stderr: "pipe", timeout: 90_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 100_000);
