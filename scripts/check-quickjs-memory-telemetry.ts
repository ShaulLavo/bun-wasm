import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = join(root, "third_party/rquickjs-sys/quickjs");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-qjs-memory-"));
function cleanup() { rmSync(scratch, { recursive: true, force: true }); }
process.once("SIGINT", () => { cleanup(); process.exit(130); });
process.once("SIGTERM", () => { cleanup(); process.exit(143); });
function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180_000, env });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} exited ${result.status}`);
}
function rustReadout() {
  const manifest = `[package]
name = "quickjs-memory-controls"
version = "0.0.0"
edition = "2024"
[workspace]
[dependencies]
rquickjs = { version = "=0.13.0", default-features = false, features = ["std", "loader", "array-buffer"] }
[patch.crates-io]
rquickjs-sys = { path = ${JSON.stringify(join(root, "third_party/rquickjs-sys"))} }
[lib]
path = "controls.rs"
`;
  const modules = { data: "crates/bunwasm-runtime/src/data.rs", engine: "crates/bunwasm-runtime/src/engine.rs", vm: "crates/bunwasm-engine-quickjs/src/vm.rs" };
  const controls = Object.entries(modules).map(([name, path]) => `#[path = ${JSON.stringify(join(root, path))}] mod ${name};`).join("\n");
  writeFileSync(join(scratch, "Cargo.toml"), manifest);
  writeFileSync(join(scratch, "controls.rs"), `#![allow(dead_code, unused_imports, unexpected_cfgs)]\n${controls}\n`);
  run("cargo", ["test", "--offline", "--manifest-path", join(scratch, "Cargo.toml"), "-j", "2", "memory_telemetry", "--", "--nocapture"],
    { ...process.env, CARGO_TARGET_DIR: join(scratch, "target") });
  const build = join(scratch, "target/debug/build/rquickjs-sys");
  const produced = readdirSync(build).map(name => join(build, name, "out")).find(path => existsSync(join(path, "libquickjs.a")));
  if (!produced) throw Error("Missing produced QuickJS library");
  nativeCounters(produced);
}
function linkInputs(produced: string | undefined) {
  const names = ["quickjs.c", "libregexp.c", "libunicode.c", "dtoa.c"];
  if (!produced) return names.map(name => join(engine, name));
  for (const name of readdirSync(engine).filter(name => /\.[ch]$/.test(name))) {
    if (!readFileSync(join(produced, name)).equals(readFileSync(join(engine, name)))) throw Error(`Produced QuickJS source mismatch: ${name}`);
  }
  return [join(produced, "libquickjs.a")];
}
function nativeCounters(produced = process.env.BUN_WASM_QUICKJS_OUT_DIR) {
  const binary = join(scratch, "telemetry");
  const sources = linkInputs(produced);
  run(process.env.CC ?? "cc", ["-D_GNU_SOURCE", "-std=gnu11", "-O0", "-Werror=implicit-function-declaration", "-I", engine,
    join(root, "scripts/fixtures/quickjs-memory-telemetry.c")].concat(sources, ["-lm", "-lpthread", "-o", binary]));
  run(binary, []);
}
try {
  if (process.argv.includes("--rust")) rustReadout();
  else nativeCounters();
} finally {
  cleanup();
  console.log(JSON.stringify({ cleanup: scratch, removed: true }));
}
