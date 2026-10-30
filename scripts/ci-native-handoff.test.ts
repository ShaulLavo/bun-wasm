import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}
const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobs = record(record(Bun.YAML.parse(source)).jobs);

test("native quality has a bounded checkpoint before the unchanged final native gate", () => {
  expect(record(jobs["native-quality"])["timeout-minutes"]).toBe(45);
  expect(record(jobs.rust)["timeout-minutes"]).toBe(60);
  expect(record(jobs["jsc-prebuild"])["timeout-minutes"]).toBe(45);
  expect(record(jobs.rust).needs).toEqual(["quality", "jsc-prebuild", "native-quality"]);
});

import { createHash } from "node:crypto";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";

function steps(id: string): Record<string, unknown>[] {
  const value = record(jobs[id]).steps;
  if (!Array.isArray(value)) throw new Error("Expected job steps");
  return value.map(record);
}
function step(id: string, name: string): Record<string, unknown> {
  const found = steps(id).filter(step => step.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
}
function script(id: string, name: string): string {
  const value = step(id, name).run;
  if (typeof value !== "string") throw new Error("Missing run command");
  return value;
}
const packName = "Package the verified native quality checkpoint";
const unpackName = "Import the verified native quality checkpoint";
const guardName = "Require the JSC prebuild job's output";
const producer = record(jobs["native-quality"]);
const consumer = record(jobs.rust);
const commands = ["bun scripts/quality-rust.ts --checks-only", "bun run quality:wasi", "bun test tests/memory-telemetry.test.ts", "--lib modules::tests::host_"];

test("quality owns one native Cargo restore and every quality command, not a second guest producer", () => {
  for (const command of commands) {
    expect(JSON.stringify(producer).split(command)).toHaveLength(2);
    expect(JSON.stringify(consumer)).not.toContain(command);
  }
  for (const id of ["native-cargo-cache", "native-cache"]) {
    const restore = steps("native-quality").find(step => step.id === id)!;
    expect(restore.uses).toBe("actions/cache/restore@v4");
    expect(steps("rust").find(step => step.id === id)?.uses).toBeUndefined();
  }
  for (const command of ["bash scripts/build-bun-core.sh", "bash scripts/build-bun-jsc.sh", "bash scripts/build.sh", "bash scripts/build-bun-tools.sh"]) {
    expect(JSON.stringify(consumer).split(command)).toHaveLength(2);
    expect(JSON.stringify(producer)).not.toContain(command);
  }
  expect(JSON.stringify(consumer)).toContain("bun scripts/test-checks.ts native");
  expect(readFileSync(new URL("./check-runtime.sh", import.meta.url), "utf8")).toContain('bun "$root/scripts/test-checks.ts" runtime');
  expect(needsRust(["scripts/ci-native-handoff.ts"])).toBe(true);
  expect(needsJsc(["scripts/ci-native-handoff.ts"])).toBe(true);
});

test("producer attempt and manifest admission come from that producer, not the consumer attempt", () => {
  expect(record(producer.outputs)["producer-attempt"]).toBe("${{ steps.native-artifact.outputs.producer-attempt }}");
  expect(record(step("native-quality", packName).env).NATIVE_QUALITY_PRODUCER_ATTEMPT).toBe("${{ github.run_attempt }}");
  expect(record(step("rust", unpackName).env).NATIVE_QUALITY_PRODUCER_ATTEMPT).toBe("${{ needs.native-quality.outputs.producer-attempt }}");
  const download = steps("rust").filter(step => step.uses === "actions/download-artifact@v4").map(step => record(step.with).name);
  expect(download).toContain("native-quality-${{ needs.native-quality.outputs.producer-attempt }}");
  for (const [job, name] of [["native-quality", packName], ["rust", unpackName]]) expect(step(job!, name!).shell).toBe("bash");
  expect(script("rust", unpackName)).not.toContain("github.run_attempt");
});

type Need = { result: string; outputs?: Record<string, string> };
function runs(job: Record<string, unknown>, needs: Record<string, Need>, cancelled: boolean): boolean {
  const declared = typeof job.needs === "string" ? [job.needs] : job.needs;
  expect(Object.keys(needs).sort()).toEqual(Array.isArray(declared) ? declared.toSorted() : []);
  if (typeof job.if !== "string") throw new Error("Expected explicit native selection");
  const expression = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "").replaceAll("!cancelled()", String(!cancelled))
    .replace(/needs\.([\w-]+)\.(result|outputs\.([\w-]+))/g, (_whole, id: string, _field: string, key: string | undefined) => JSON.stringify(key ? needs[id]?.outputs?.[key] : needs[id]?.result));
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw new Error("Non-boolean condition");
  const implicit = job.if.includes("cancelled()") || Object.values(needs).every(need => need.result === "success");
  return !cancelled && implicit && result;
}

test("full selection/result matrix never skips a needed failed, cancelled or skipped producer", () => {
  for (const quality of ["success", "failure", "cancelled", "skipped"]) checkSelection(quality);
});
function checkSelection(quality: string): void {
  for (const selected of ["true", "false"]) for (const jsc of ["true", "false"]) checkResults({ result: quality, outputs: { rust: selected, jsc } });
}
function checkResults(quality: Need): void {
  for (const prebuild of ["success", "failure", "cancelled", "skipped"]) for (const checkpoint of ["success", "failure", "cancelled", "skipped"]) checkCancellation(quality, prebuild, checkpoint);
}
function checkCancellation(quality: Need, prebuild: string, checkpoint: string): void {
  for (const cancelled of [false, true]) {
    const selected = quality.result === "success" && quality.outputs?.rust === "true" && !cancelled;
    expect(runs(producer, { quality, "jsc-prebuild": { result: prebuild } }, cancelled)).toBe(selected);
    expect(runs(consumer, { quality, "jsc-prebuild": { result: prebuild }, "native-quality": { result: checkpoint } }, cancelled)).toBe(selected);
  }
}

test("both real guard scripts fail before setup on every unsuccessful prerequisite", () => {
  for (const prebuild of ["success", "failure", "cancelled", "skipped", ""]) checkGuard(prebuild);
});
function checkGuard(prebuild: string): void {
  const quality = spawnSync("bash", ["-e", "-c", script("native-quality", guardName)], { env: { ...process.env, JSC_PREBUILD_RESULT: prebuild } });
  expect(quality.status).toBe(prebuild === "success" ? 0 : 1);
  for (const checkpoint of ["success", "failure", "cancelled", "skipped", ""]) {
    const native = spawnSync("bash", ["-e", "-c", script("rust", guardName)], { env: { ...process.env, JSC_PREBUILD_RESULT: prebuild, NATIVE_QUALITY_RESULT: checkpoint } });
    expect(native.status).toBe(prebuild === "success" && checkpoint === "success" ? 0 : 1);
  }
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory].concat(args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function repository(directory: string): void {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Fixture");
  git(directory, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(directory, "source"), "public source\n", { mode: 0o751 });
  mkdirSync(join(directory, "fixtures/node_modules/public"), { recursive: true });
  writeFileSync(join(directory, "fixtures/node_modules/public/index.ts"), "export const fixture = true;\n");
  git(directory, "add", "-f", "source", "fixtures/node_modules/public/index.ts");
  git(directory, "commit", "-qm", "fixture");
  mkdirSync(join(directory, "node_modules/private"), { recursive: true });
  writeFileSync(join(directory, "node_modules/private/.npmrc"), "fixture-auth-do-not-package");
  writeFileSync(join(directory, "fixtures/node_modules/public/.npmrc"), "fixture-auth-do-not-package");
}
function fixture(run: (root: string, env: Record<string, string>, invoke: (job: string, name: string, changes?: Record<string, string>) => SpawnSyncReturns<string>) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-native-handoff-"));
  try { runFixture(root, run); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function runFixture(root: string, run: Parameters<typeof fixture>[0]): void {
  const workspace = join(root, "repo"), temp = join(root, "temp"), cargo = join(temp, "cargo");
  repository(workspace);
  repository(join(workspace, "vendor/bun"));
  for (const path of ["target/deps", "vendor/boringssl", "scripts"]) mkdirSync(join(workspace, path), { recursive: true });
  for (const path of ["registry/cache", "git/db/public/objects", "bin"]) mkdirSync(join(cargo, path), { recursive: true });
  git(join(cargo, "git/db/public"), "init", "--bare", "-q");
  repository(join(cargo, "git/checkouts/public/abc"));
  mkdirSync(join(temp, "sysroot"));
  writeFileSync(join(temp, "sysroot/bun-wasm-sysroot.json"), "verified public sysroot\n");
  copyFileSync(new URL("./ci-native-handoff.ts", import.meta.url), join(workspace, "scripts/ci-native-handoff.ts"));
  writeFileSync(join(workspace, "env.sh"), 'export BUN_WASM_SYSROOT="$RUNNER_TEMP/sysroot"\n');
  const bunHead = git(join(workspace, "vendor/bun"), "rev-parse", "HEAD");
  const verifier = readFileSync(new URL("./sync-bun.sh", import.meta.url), "utf8")
    .replace(/^BUN_COMMIT=[a-f0-9]{40}$/m, `BUN_COMMIT=${bunHead}`)
    .replace('  echo "vendor/bun source verified at', '  printf verified > "$RUNNER_TEMP/source-verified"\n  echo "vendor/bun source verified at');
  writeFileSync(join(workspace, "scripts/sync-bun.sh"), verifier);
  writeFileSync(join(workspace, "target/deps/native"), "compiled fixture bytes\n", { mode: 0o751 });
  utimesSync(join(workspace, "target/deps/native"), 1234567890.125, 1234567890.125);
  symlinkSync("native", join(workspace, "target/deps/link"));
  chmodSync(join(workspace, "target/deps"), 0o750);
  utimesSync(join(workspace, "target/deps"), 1234567890.125, 1234567890.125);
  writeFileSync(join(workspace, "vendor/boringssl/header.h"), "public fixture\n");
  writeFileSync(join(cargo, "registry/cache/public"), "public crate\n");
  writeFileSync(join(cargo, "bin/cargo-machete"), "fixture binary\n", { mode: 0o755 });
  writeFileSync(join(cargo, "credentials.toml"), "fixture-auth-do-not-package");
  for (const config of [join(workspace, ".git/config"), join(workspace, "vendor/bun/.git/config"), join(cargo, "git/db/public/config")]) execFileSync("sh", ["-c", 'printf "\\n[http]\\nextraheader = fixture-auth-do-not-package\\n" >> "$1"', "fixture", config]);
  const env = { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp, CARGO_HOME: cargo, CARGO_TARGET_DIR: join(workspace, "target"),
    TMPDIR: temp, GITHUB_SHA: git(workspace, "rev-parse", "HEAD"), GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "7", NATIVE_QUALITY_PRODUCER_ATTEMPT: "7",
    NATIVE_HOST_TOOLS_HASH: "a".repeat(64), NATIVE_INPUTS_HASH: "b".repeat(64), JSC_PREBUILD_MANIFEST_SHA256: "c".repeat(64), GITHUB_OUTPUT: join(temp, "outputs") };
  const invoke = (job: string, name: string, changes: Record<string, string> = {}) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script(job, name)], { cwd: workspace, env: { ...env, ...changes }, encoding: "utf8", timeout: 10000 });
  run(root, env, invoke);
}
function prepareImport(root: string, env: Record<string, string>, invoke: Parameters<Parameters<typeof fixture>[0]>[2]): Record<string, string> {
  const packed = invoke("native-quality", packName);
  expect(packed.status, packed.stderr.slice(0, 8000)).toBe(0);
  const values = Object.fromEntries(readFileSync(env.GITHUB_OUTPUT!, "utf8").trim().split("\n").map(row => row.split("=")));
  for (const path of ["repo/target", "repo/vendor/bun", "repo/vendor/boringssl", "temp/cargo/registry", "temp/cargo/git", "temp/cargo/bin/cargo-machete"]) rmSync(join(root, path), { recursive: true, force: true });
  writeFileSync(env.GITHUB_OUTPUT!, "");
  return { NATIVE_QUALITY_MANIFEST_SHA256: String(values["manifest-sha256"]) };
}

test("real workflow scripts preserve bytes, file modes, symlinks, mtimes and upstream Git without credentials", () => {
  fixture((root, env, invoke) => {
    const expectedHead = git(join(root, "repo/vendor/bun"), "rev-parse", "HEAD");
    const changes = prepareImport(root, env, invoke);
    const bundle = join(root, "temp/native-quality-artifact");
    for (const archive of ["target", "cargo", "sources"]) {
      const bytes = execFileSync("zstd", ["-dc", join(bundle, `${archive}.tar.zst`)]);
      expect(bytes.includes(Buffer.from("fixture-auth-do-not-package"))).toBe(false);
    }
    const imported = invoke("rust", unpackName, { ...changes, GITHUB_RUN_ATTEMPT: "8" });
    expect(imported.status, imported.stderr).toBe(0);
    const path = join(root, "repo/target/deps/native");
    expect(readFileSync(path, "utf8")).toBe("compiled fixture bytes\n");
    expect(statSync(path).mode & 0o777).toBe(0o751);
    expect(statSync(path).mtimeMs).toBe(1234567890125);
    expect(statSync(join(root, "repo/target/deps")).mode & 0o777).toBe(0o750);
    expect(statSync(join(root, "repo/target/deps")).mtimeMs).toBe(1234567890125);
    expect(lstatSync(join(root, "repo/target/deps/link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "repo/target/deps/link"))).toBe("native");
    expect(git(join(root, "repo/vendor/bun"), "rev-parse", "HEAD")).toBe(expectedHead);
    expect(git(join(root, "repo/vendor/bun"), "config", "--local", "--list")).not.toContain("extraheader");
    expect(git(join(root, "temp/cargo/git/db/public"), "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(join(root, "temp/cargo/git/checkouts/public/abc"), "status", "--porcelain")).toBe("");
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("native-ready=true\n");
    expect(existsSync(join(root, "temp/source-verified"))).toBe(true);
  });
});

test("tracked dependency fixtures survive while installed packages stay private", () => {
  fixture((root, env, invoke) => {
    const changes = prepareImport(root, env, invoke);
    const imported = invoke("rust", unpackName, changes);
    expect(imported.status, imported.stderr).toBe(0);
    for (const path of ["repo/vendor/bun", "temp/cargo/git/checkouts/public/abc"]) {
      const repository = join(root, path);
      expect(readFileSync(join(repository, "fixtures/node_modules/public/index.ts"), "utf8")).toBe("export const fixture = true;\n");
      expect(existsSync(join(repository, "node_modules/private"))).toBe(false);
      expect(existsSync(join(repository, "fixtures/node_modules/public/.npmrc"))).toBe(false);
      expect(git(repository, "status", "--porcelain", "--untracked-files=no")).toBe("");
    }
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("native-ready=true\n");
  });
});

function largeTrackedSource(directory: string, listing: string): void {
  const path = join(directory, ...Array.from({ length: 5 }, (_, index) => `source-${index}-${"x".repeat(210)}`));
  mkdirSync(path, { recursive: true });
  for (let index = 0; index < 1024; index++) writeFileSync(join(path, `${index}.ts`), "");
  git(directory, "add", "--", path);
  git(directory, "commit", "-qm", "large tracked source inventory");
  const output = openSync(listing, "w");
  try { execFileSync("git", ["-C", directory, "ls-files", "-z"], { stdio: ["ignore", output, "pipe"] }); }
  finally { closeSync(output); }
  expect(statSync(listing).size).toBeGreaterThan(1024 * 1024);
}

test("large tracked source inventories preserve dependency fixtures without overflowing Git output", () => {
  fixture((root, env, invoke) => {
    const repository = join(root, "repo/vendor/bun");
    writeFileSync(join(repository, "node_modules/public.ts"), "public root fixture\n");
    mkdirSync(join(repository, "fixtures/exact"));
    writeFileSync(join(repository, "fixtures/exact/node_modules"), "public exact-name fixture\n");
    git(repository, "add", "-f", "node_modules/public.ts", "fixtures/exact/node_modules");
    largeTrackedSource(repository, join(root, "tracked-paths"));
    const verifier = join(root, "repo/scripts/sync-bun.sh");
    writeFileSync(verifier, readFileSync(verifier, "utf8").replace(/^BUN_COMMIT=[a-f0-9]{40}$/m, `BUN_COMMIT=${git(repository, "rev-parse", "HEAD")}`));
    const changes = prepareImport(root, env, invoke);
    const imported = invoke("rust", unpackName, changes);
    expect(imported.status, imported.stderr).toBe(0);
    expect(readFileSync(join(repository, "fixtures/node_modules/public/index.ts"), "utf8")).toBe("export const fixture = true;\n");
    expect(readFileSync(join(repository, "node_modules/public.ts"), "utf8")).toBe("public root fixture\n");
    expect(readFileSync(join(repository, "fixtures/exact/node_modules"), "utf8")).toBe("public exact-name fixture\n");
    expect(existsSync(join(repository, "fixtures/node_modules/public/.npmrc"))).toBe(false);
    expect(existsSync(join(repository, "node_modules/private"))).toBe(false);
    expect(git(repository, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("native-ready=true\n");
    expect(existsSync(join(root, "temp/source-verified"))).toBe(true);
  });
});

const foreignInputs = [
  ["NATIVE_QUALITY_MANIFEST_SHA256", "f".repeat(64)], ["GITHUB_RUN_ID", "5678"], ["GITHUB_SHA", "d".repeat(40)],
  ["NATIVE_QUALITY_PRODUCER_ATTEMPT", "8"], ["NATIVE_HOST_TOOLS_HASH", "e".repeat(64)], ["NATIVE_INPUTS_HASH", "e".repeat(64)],
  ["JSC_PREBUILD_MANIFEST_SHA256", "e".repeat(64)], ["NATIVE_QUALITY_MANIFEST_SHA256", ""], ["GITHUB_WORKSPACE", "/foreign/checkout"], ["CARGO_HOME", "/wrong/cargo"], ["CARGO_TARGET_DIR", "/wrong/target"],
] satisfies [string, string][];
for (const [name, value] of foreignInputs) test(`real import rejects foreign ${name} before source validation or readiness`, () => {
  fixture((root, env, invoke) => {
    const changes = prepareImport(root, env, invoke);
    const imported = invoke("rust", unpackName, { ...changes, [name]: value });
    expect(imported.status).not.toBe(0);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
    expect(existsSync(join(root, "temp/source-verified"))).toBe(false);
    expect(existsSync(join(root, "repo/target"))).toBe(false);
  });
});

for (const mode of ["corrupt", "missing", "extra", "overlay", "sysroot", "manifest", "tree", "bun-head", "source-check"] as const) test(`real import rejects ${mode} state without readiness`, () => {
  fixture((root, env, invoke) => {
    const changes = prepareImport(root, env, invoke);
    const bundle = join(root, "temp/native-quality-artifact");
    mutateFixture(mode, root, bundle, changes);
    const imported = invoke("rust", unpackName, changes);
    expect(imported.status, imported.stdout).not.toBe(0);
    expect(readFileSync(env.GITHUB_OUTPUT!, "utf8")).toBe("");
    if (mode !== "source-check") expect(existsSync(join(root, "temp/source-verified"))).toBe(false);
  });
});
function mutateFixture(mode: string, root: string, bundle: string, changes: Record<string, string>): void {
  if (mode === "corrupt") {
    const path = join(bundle, "target.tar.zst");
    const tar = execFileSync("zstd", ["-dc", path]);
    const original = Buffer.from("compiled fixture bytes\n");
    const offset = tar.indexOf(original);
    expect(offset).toBeGreaterThan(-1);
    tar.set(Buffer.from("modified fixture bytes\n"), offset);
    execFileSync("zstd", ["-f", "-o", path], { input: tar, stdio: ["pipe", "ignore", "ignore"] });
  }
  if (mode === "missing") rmSync(join(bundle, "sources.tar.zst"));
  if (mode === "extra") writeFileSync(join(bundle, "foreign"), "unexpected");
  if (mode === "overlay") mkdirSync(join(root, "repo/target"));
  if (mode === "sysroot") writeFileSync(join(root, "temp/sysroot/bun-wasm-sysroot.json"), "different sysroot");
  if (mode === "source-check") writeFileSync(join(root, "repo/scripts/sync-bun.sh"), "exit 42\n");
  if (!["manifest", "tree", "bun-head"].includes(mode)) return;
  const path = join(bundle, "manifest.json");
  const data = record(JSON.parse(readFileSync(path, "utf8")));
  if (mode === "manifest") data.archives = { ...record(data.archives), "foreign.tar.zst": "a".repeat(64) };
  if (mode === "tree") data.identity = { ...record(data.identity), tree: "0".repeat(40) };
  if (mode === "bun-head") data.bun = { ...record(data.bun), head: "0".repeat(40) };
  writeFileSync(path, JSON.stringify(data));
  changes.NATIVE_QUALITY_MANIFEST_SHA256 = createHash("sha256").update(readFileSync(path)).digest("hex");
}

for (const tool of ["tar", "zstd"]) test(`real package cannot advertise a checkpoint after ${tool} fails`, () => {
  fixture((root, env, invoke) => {
    const bin = join(root, "fault-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 43\n", { mode: 0o755 });
    const result = invoke("native-quality", packName, { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).not.toBe(0);
    expect(existsSync(env.GITHUB_OUTPUT!)).toBe(false);
  });
});

test("cache handoff preserves exact, prefix and missing restore results without restoring again", () => {
  for (const hit of ["true", "false", ""]) for (const matched of ["", "saved-exact", "saved-prefix"]) checkCacheBridge(hit, matched);
});
function checkCacheBridge(hit: string, matched: string): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-native-cache-bridge-"));
  try {
    const output = join(root, "outputs");
    const result = spawnSync("bash", ["-e", "-c", script("rust", "Carry the original native cache restore result")], { env: { ...process.env, GITHUB_OUTPUT: output, CACHE_HIT: hit, CACHE_MATCHED: matched } });
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`cache-hit=${hit}\ncache-matched-key=${matched}\n`);
    writeFileSync(output, "");
    const legacy = spawnSync("bash", ["-e", "-c", script("rust", "Carry the original legacy cache restore result")], { env: { ...process.env, GITHUB_OUTPUT: output, CACHE_HIT: hit } });
    expect(legacy.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`cache-hit=${hit}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
