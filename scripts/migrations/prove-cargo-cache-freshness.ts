// On-demand native proof, not another CI build owner. Run after sourcing env.sh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const reportArgument = process.argv[2];
if (!reportArgument) throw new Error("Usage: bun scripts/migrations/prove-cargo-cache-freshness.ts <report-directory>");
const report = resolve(reportArgument);
mkdirSync(report, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "bun-wasm-cargo-freshness-"));
writeFileSync(join(report, "ownership.json"), JSON.stringify({ root }) + "\n");
const target = join(root, "target"), seed = join(root, "seed.tar");
const repository = resolve(import.meta.dir, "../..");
const timeHelper = join(repository, "scripts/quality-input-times.ts");
const deadline = join(repository, "scripts/run-with-timeout.mts");
const cli = "crates/bunwasm-cli";
const quickjs = "third_party/rquickjs-sys/quickjs/quickjs.c";
const environment = { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: "0", CARGO_TERM_COLOR: "never" };
const results: object[] = [];

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(label: string, command: readonly string[], env = environment): string {
  const started = performance.now();
  const args = [deadline, "120"].concat(command);
  const child = spawnSync("node", args, { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(report, `${label}.log`), child.stdout + child.stderr);
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${label}: ${child.stderr}`);
  results.push({ label, command, elapsedMs: Math.round(performance.now() - started), logSha256: sha256(join(report, `${label}.log`)) });
  return child.stdout;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function setup(): void {
  cpSync(join(repository, "third_party/rquickjs-sys"), join(root, "third_party/rquickjs-sys"), { recursive: true });
  write("Cargo.toml", `[workspace]\nresolver = "2"\nmembers = ["${cli}", "crates/unrelated"]\n[profile.dev]\ndebug = 0\n`);
  write("crates/unrelated/Cargo.toml", '[package]\nname = "cache-proof-unrelated"\nversion = "0.0.0"\nedition = "2024"\n');
  write("crates/unrelated/src/lib.rs", "pub fn value() -> u32 { 7 }\n");
  const cc = readFileSync(join(repository, "Cargo.lock"), "utf8").match(/name = "cc"\nversion = "([^"]+)"/u)?.[1];
  assert.ok(cc, "workspace cc pin");
  write(`${cli}/Cargo.toml`, `[package]\nname = "cache-proof-cli"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\ncache-proof-unrelated = { path = "../unrelated" }\nrquickjs-sys = { path = "../../third_party/rquickjs-sys" }\n[build-dependencies]\ncc = "=${cc}"\n`);
  write(`${cli}/build.rs`, 'fn main() {\n    println!("cargo:rerun-if-changed=entry-split.c");\n    println!("cargo:rustc-env=CACHE_PROOF_TAG=1");\n    cc::Build::new().file("entry-split.c").compile("cache_proof_entry");\n}\n');
  write(`${cli}/entry-split.c`, "int cache_proof_entry(void) { return 1; }\n");
  write(`${cli}/src/main.rs`, 'unsafe extern "C" { fn cache_proof_entry() -> i32; }\nfn main() {\n    let version = unsafe { std::ffi::CStr::from_ptr(rquickjs_sys::JS_GetVersion()) };\n    println!("{}:{}:{}:{}", version.to_str().unwrap(), unsafe { cache_proof_entry() }, env!("CACHE_PROOF_TAG"), cache_proof_unrelated::value());\n}\n');
}

type Artifact = { name: string; fresh: boolean };
function artifacts(output: string): Artifact[] {
  return output.trim().split("\n").flatMap(line => {
    const row: unknown = JSON.parse(line);
    if (typeof row !== "object" || row === null || !("reason" in row) || row.reason !== "compiler-artifact") return [];
    assert.ok("target" in row && typeof row.target === "object" && row.target !== null && "name" in row.target && typeof row.target.name === "string");
    assert.ok("fresh" in row && typeof row.fresh === "boolean");
    return [{ name: row.target.name, fresh: row.fresh }];
  });
}

function build(label: string): Artifact[] {
  return artifacts(run(label, ["cargo", "build", "--offline", "--locked", "-j", "2", "-p", "cache-proof-cli", "--message-format=json", "--verbose"]));
}

function assertFresh(rows: readonly Artifact[], name: string, fresh: boolean): void {
  const found = rows.filter(row => row.name === name);
  assert.equal(found.length, 1, `one artifact for ${name}`);
  assert.equal(found[0]?.fresh, fresh, `${name} freshness`);
}

function restore(): void {
  rmSync(target, { recursive: true, force: true });
  run("restore", ["tar", "-xf", seed]);
}

function checkoutTimes(): void {
  // Checkout/archive mtimes are deliberately wrong; only the production helper repairs them.
  for (const path of [quickjs, `${cli}/build.rs`, `${cli}/entry-split.c`, `${cli}/src/main.rs`, "crates/unrelated/src/lib.rs"]) utimesSync(join(root, path), 1, 1);
}

function assertBuild(caseName: string, expected: string, quickjsFresh: boolean): void {
  run(`${caseName}-input-times`, ["bun", timeHelper]);
  const rows = build(`${caseName}-build`);
  assertFresh(rows, "cache_proof_unrelated", true);
  assertFresh(rows, "rquickjs_sys", quickjsFresh);
  assertFresh(rows, "cache-proof-cli", false);
  for (const dependency of ["cc", "shlex", "find_msvc_tools"]) assertFresh(rows, dependency, true);
  const output = run(`${caseName}-execute`, [join(target, "debug/cache-proof-cli")]).trim();
  assert.equal(output, expected, `${caseName} must not accept stale executable output`);
  results.push({ caseName, artifacts: rows, output, binarySha256: sha256(join(target, "debug/cache-proof-cli")) });
}

function proof(): void {
  setup();
  run("lock", ["cargo", "generate-lockfile", "--offline"]);
  run("seed-input-times", ["bun", timeHelper]);
  build("seed-build");
  const original = run("seed-execute", [join(target, "debug/cache-proof-cli")]).trim();
  const version = original.split(":")[0];
  assert.ok(version);
  assert.equal(original, `${version}:1:1:7`);
  const baselineBinary = sha256(join(target, "debug/cache-proof-cli"));
  run("archive", ["tar", "--format=posix", "-cf", seed, "target"]);
  restore();
  checkoutTimes();
  run("unchanged-input-times", ["bun", timeHelper]);
  const unchanged = build("unchanged-build");
  assert.ok(unchanged.length > 0 && unchanged.every(row => row.fresh), "restored unchanged control must be entirely Fresh");
  assert.equal(sha256(join(target, "debug/cache-proof-cli")), baselineBinary);
  results.push({ caseName: "unchanged", artifacts: unchanged, binarySha256: baselineBinary });
  const source = readFileSync(join(root, quickjs), "utf8");
  assert.equal(source.split("return QJS_VERSION_STRING;").length, 2);
  restore();
  write(quickjs, source.replace("return QJS_VERSION_STRING;", 'return "cache-proof-changed";'));
  checkoutTimes();
  assertBuild("quickjs", "cache-proof-changed:1:1:7", false);
  write(quickjs, source);
  restore();
  const buildScript = readFileSync(join(root, cli, "build.rs"), "utf8");
  write(`${cli}/build.rs`, buildScript.replace("CACHE_PROOF_TAG=1", "CACHE_PROOF_TAG=2"));
  checkoutTimes();
  assertBuild("build-script", `${version}:1:2:7`, true);
  write(`${cli}/build.rs`, buildScript);
  restore();
  write(`${cli}/entry-split.c`, "int cache_proof_entry(void) { return 2; }\n");
  checkoutTimes();
  assertBuild("entry", `${version}:2:1:7`, true);
}

try {
  proof();
  writeFileSync(join(report, "proof.json"), JSON.stringify({
    qualification: "Native Cargo target restored from tar at its original path; real vendored rquickjs-sys, original native link fixture, production input-time CLI. No guest, JSC prebuild or Actions cache hit/timing claim.",
    source: { quickjs: sha256(join(repository, quickjs)), quickjsBuild: sha256(join(repository, "third_party/rquickjs-sys/build.rs")), timeHelper: sha256(timeHelper), proof: sha256(import.meta.path) },
    results,
  }, null, 2) + "\n");
} finally {
  rmSync(root, { recursive: true, force: true });
  writeFileSync(join(report, "cleanup.json"), JSON.stringify({ root, removed: !existsSync(root), retained: "small logs and proof only; parent owns retention" }) + "\n");
}
