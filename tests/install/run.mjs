// source env.sh && node tests/install/run.mjs
// BUN_WASM_LAUNCHER, BUN_WASM and INSTALL_CASES=comma,separated override defaults.
// INSTALL_NATIVE_BUN=1 checks the fixtures against native Bun instead of wasm.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry } from "./registry.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const scratch = mkdtempSync(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), "bun-wasm-install-test-"));
const children = new Set();
let registry;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of children) child.kill("SIGKILL");
  await registry?.close();
  rmSync(scratch, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
process.on("exit", () => { for (const child of children) child.kill("SIGKILL"); rmSync(scratch, { recursive: true, force: true }); });

function project(name, manifest = { name: "install-fixture", version: "1.0.0" }) {
  const directory = join(scratch, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

async function bun(directory, args, success = true, overrides = {}) {
  const native = process.env.INSTALL_NATIVE_BUN === "1";
  const browser = process.env.INSTALL_ENGINE === "browser";
  const env = { ...process.env, NPM_CONFIG_REGISTRY: registry.base, BUN_INSTALL_CACHE_DIR: join(directory, "cache"), ...overrides };
  const launcher = process.env.BUN_WASM_LAUNCHER ?? "/work/tmp/bun-wasm-target/release/bun-wasm";
  const options = ["--wasm", resolve(root, process.env.BUN_WASM ?? "dist/bun.wasm"), "--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${env.NPM_CONFIG_REGISTRY}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--env", `BUN_CONFIG_HTTP_IDLE_TIMEOUT=${env.BUN_CONFIG_HTTP_IDLE_TIMEOUT ?? "300"}`, "--"];
  const nativeArgs = ["install", "i", "add", "remove"].includes(args[0]) ? args.concat(["--linker=hoisted"]) : args;
  const nodeArgs = ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(options, args);
  const executable = native ? "bun" : browser ? "node" : launcher;
  const child = spawn(executable, native ? nativeArgs : browser ? nodeArgs : options.concat(args), { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => { clearTimeout(timeout); children.delete(child); });
  const output = stdout.concat(stderr);
  if (success) assert.equal(code, 0, `bun ${args.join(" ")} exited ${code}\n${output}`);
  else if (success === false) assert.notEqual(code, 0, `bun ${args.join(" ")} unexpectedly succeeded\n${output}`);
  return { code, stdout, stderr, output };
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function installed(directory, name) {
  return JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8"));
}

const cases = {
  async wasmDistributions() {
    const directory = project("wasm-distributions", { dependencies: { esbuild: "0.25.12", "uses-esbuild": "1.0.0" } });
    await bun(directory, ["install"]);
    assert.equal(installed(directory, "esbuild").name, "esbuild-wasm");
    assert.equal(installed(directory, "esbuild").version, "0.25.12");
    const result = await bun(directory, ["-e", "console.log(require('esbuild'), require('uses-esbuild'))"]);
    assert.equal(result.stdout.trim(), "esbuild-wasm@0.25.12 esbuild-wasm@0.25.12");
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    assert.match(lock, /esbuild-wasm@0\.25\.12/);
    rmSync(join(directory, "node_modules"), { recursive: true });
    registry.setOffline(true);
    try { await bun(directory, ["install", "--frozen-lockfile"]); }
    finally { registry.setOffline(false); }
    assert.equal(installed(directory, "esbuild").name, "esbuild-wasm");
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
    const transitive = project("wasm-transitive", { dependencies: { "uses-esbuild": "1.0.0" } });
    await bun(transitive, ["install"]);
    assert.equal(installed(transitive, "esbuild").name, "esbuild-wasm");
    const missing = project("wasm-missing", { dependencies: { esbuild: "0.25.11" } });
    assert.match((await bun(missing, ["install"], false)).output, /No version matching.*0\.25\.11.*esbuild-wasm/);
  },
  async aliases() {
    const directory = project("aliases", { name: "install-fixture", dependencies: { "is-odd": "3.0.1" } });
    const result = await bun(directory, ["i"]);
    if (process.env.INSTALL_CAPTURE_REFERENCE) {
      const normalized = text => text.replaceAll(registry.base, "REGISTRY").replace(/\[[\d.]+m?s\]/g, "[TIME]");
      writeFileSync(resolve(process.env.INSTALL_CAPTURE_REFERENCE), `${JSON.stringify({ stdout: normalized(result.stdout), stderr: normalized(result.stderr), lock: normalized(readFileSync(join(directory, "bun.lock"), "utf8")) }, null, 2)}\n`);
    }
    assert.match(result.output, /2 packages installed \[[\d.]+m?s\]/);
    assert.equal(installed(directory, "is-odd").version, "3.0.1");
    assert.equal(installed(directory, "is-number").version, "7.0.0");
    const run = await bun(directory, ["-e", "console.log(require('is-odd')(3), require('is-odd')(4))"]);
    assert.equal(run.stdout.trim(), "true false");
    const listed = await bun(directory, ["pm", "ls"]);
    assert.match(listed.output, /is-odd@3\.0\.1/);
    await bun(directory, ["install"]);
  },
  async add() {
    const directory = project("add");
    await bun(directory, ["add", "is-odd"]);
    assert.equal(manifest(directory).dependencies["is-odd"], "^3.0.1");
    await bun(directory, ["add", "@fixture/scoped@1.0.0", "--exact"]);
    assert.equal(manifest(directory).dependencies["@fixture/scoped"], "1.0.0");
    assert.equal(installed(directory, "@fixture/scoped").version, "1.0.0");
    await bun(directory, ["remove", "is-odd"]);
    assert.equal(manifest(directory).dependencies?.["is-odd"], undefined);
    assert.equal(existsSync(join(directory, "node_modules/is-odd")), false);
    assert.equal(installed(directory, "@fixture/scoped").version, "1.0.0");
  },
  async dev() {
    for (const flag of ["-d", "-D", "--dev"]) {
      const directory = project(`dev-${flag.slice(1)}`);
      await bun(directory, ["add", flag, "versioned@~1.0.0"]);
      assert.equal(manifest(directory).devDependencies.versioned, "~1.0.0");
      assert.equal(manifest(directory).dependencies?.versioned, undefined);
      assert.equal(installed(directory, "versioned").version, "1.0.0");
    }
  },
  async lock() {
    const directory = project("lock", { name: "install-fixture", dependencies: { versioned: "latest" } });
    registry.latest.set("versioned", "1.0.0");
    await bun(directory, ["install"]);
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    registry.latest.set("versioned", "2.0.0");
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    await bun(directory, ["install"]);
    assert.equal(installed(directory, "versioned").version, "1.0.0");
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock, "unchanged install rewrote lockfile");
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    registry.setOffline(true);
    try { await bun(directory, ["install"]); } finally { registry.setOffline(false); }
    assert.equal(installed(directory, "versioned").version, "1.0.0");
  },
  async lockFormat() {
    const directory = project("lock-format", { name: "install-fixture", dependencies: { "is-odd": "3.0.1" } });
    await bun(directory, ["install"]);
    const expected = JSON.parse(readFileSync(join(root, "tests/install/native-reference.json"), "utf8")).lock;
    const lock = readFileSync(join(directory, "bun.lock"), "utf8").replaceAll(registry.base, "REGISTRY");
    assert.equal(lock, expected, "simple-project bun.lock differs from native Bun byte format");
  },
  async dependencies() {
    const directory = project("dependencies", { name: "install-fixture", dependencies: { "uses-one": "1.0.0", "uses-two": "1.0.0", "peer-user": "1.0.0", "optional-user": "1.0.0", lifecycle: "1.0.0" } });
    const result = await bun(directory, ["install"]);
    const run = await bun(directory, ["-e", "console.log(require('uses-one'), require('uses-two'), require('peer-user'))"]);
    assert.equal(run.stdout.trim(), "versioned@1.1.0 versioned@2.0.0 true");
    assert.match(result.output, /Blocked 1 postinstall/);
    assert.equal(existsSync(join(directory, "node_modules/lifecycle/POSTINSTALL-RAN")), false);
    assert.equal(existsSync(join(directory, "node_modules/missing-optional")), false);
  },
  async registryConfig() {
    const directory = project("registry-config");
    writeFileSync(join(directory, "bunfig.toml"), `[install]\nregistry = ${JSON.stringify(registry.base)}\n`);
    await bun(directory, ["add", "is-odd"], true, { NPM_CONFIG_REGISTRY: "" });
    assert.equal(installed(directory, "is-odd").version, "3.0.1");
  },
  async integrity() {
    const directory = project("integrity");
    const result = await bun(directory, ["add", "bad-integrity"], false);
    assert.match(result.output, /integrity|checksum|verification/i);
    assert.equal(existsSync(join(directory, "node_modules/bad-integrity/index.js")), false);
  },
  async idleTimeout() {
    const directory = project("idle-timeout");
    const started = Date.now();
    const result = await bun(directory, ["add", "is-odd"], false, {
      NPM_CONFIG_REGISTRY: registry.base + "/stall", BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1", BUN_CONFIG_HTTP_RETRY_COUNT: "0",
    });
    assert.match(result.output, /timeout|timed out/i);
    assert.ok(Date.now() - started < 10000, "stalled registry did not honor the configured timeout");
    assert.equal(existsSync(join(directory, "node_modules/is-odd")), false);
  },
  async archiveSafety() {
    for (const name of ["path-escape", "link-escape"]) {
      const directory = project(name);
      await bun(directory, ["add", name], null);
      assert.equal(existsSync(join(scratch, "ESCAPED")), false);
      assert.equal(existsSync(join(directory, "ESCAPED")), false);
    }
  },
  async removeTransitive() {
    const directory = project("remove-transitive", { name: "install-fixture", dependencies: { "is-number": "7.0.0", "is-odd": "3.0.1" } });
    await bun(directory, ["install"]);
    await bun(directory, ["remove", "is-number"]);
    assert.deepEqual(manifest(directory).dependencies, { "is-odd": "3.0.1" }, "remove restored a transitive dependency to package.json");
    assert.equal(installed(directory, "is-number").version, "7.0.0");
    const result = await bun(directory, ["-e", "console.log(require('is-odd')(3))"]);
    assert.equal(result.stdout.trim(), "true");
    await bun(directory, ["install", "--frozen-lockfile"]);
    assert.deepEqual(manifest(directory).dependencies, { "is-odd": "3.0.1" });
  },
  async requiredOptionalIntegrity() {
    const directory = project("required-optional-integrity", { name: "install-fixture", optionalDependencies: { "bad-integrity": "1.0.0" }, dependencies: { "z-required-integrity": "1.0.0" } });
    const result = await bun(directory, ["install"], false);
    assert.match(result.output, /integrity|checksum|verification/i);
    assert.equal(existsSync(join(directory, "node_modules/bad-integrity/index.js")), false);
  },
  async optionalPeerLock() {
    const directory = project("optional-peer-lock", { name: "install-fixture", dependencies: { "optional-peer-user": "1.0.0" } });
    await bun(directory, ["install"]);
    assert.equal(existsSync(join(directory, "node_modules/versioned")), false);
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    const before = registry.requests.length;
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    await bun(directory, ["install", "--frozen-lockfile"]);
    assert.equal(existsSync(join(directory, "node_modules/versioned")), false, "locked install added an optional peer");
    assert.equal(registry.requests.slice(before).some(request => request.path === "/versioned"), false);
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
  },
  async optionalOverridesRequired() {
    const directory = project("optional-overrides-required", { name: "install-fixture", dependencies: { versioned: "1.0.0" }, optionalDependencies: { versioned: "2.0.0" } });
    await bun(directory, ["install"]);
    assert.equal(installed(directory, "versioned").version, "2.0.0");
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    await bun(directory, ["install", "--frozen-lockfile"]);
    assert.equal(installed(directory, "versioned").version, "2.0.0");
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
  },
  async productionFrozen() {
    const directory = project("production-frozen", { name: "install-fixture", dependencies: { "is-odd": "3.0.1" }, devDependencies: { "@fixture/scoped": "1.0.0" } });
    await bun(directory, ["install"]);
    assert.equal(installed(directory, "@fixture/scoped").version, "1.0.0");
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    await bun(directory, ["install", "--production", "--frozen-lockfile"]);
    assert.equal(installed(directory, "is-odd").version, "3.0.1");
    assert.equal(installed(directory, "is-number").version, "7.0.0");
    assert.equal(existsSync(join(directory, "node_modules/@fixture/scoped")), false);
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock, "production install rewrote the full lockfile");
  },
  async taggedCycle() {
    const directory = project("tagged-cycle", { name: "install-fixture", dependencies: { "cycle-a": "latest" } });
    await bun(directory, ["install"]);
    const result = await bun(directory, ["-e", "console.log(require('cycle-a').other, require('cycle-b').other)"]);
    assert.equal(result.stdout.trim(), "cycle-b cycle-a");
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    await bun(directory, ["install", "--frozen-lockfile"]);
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
  },
  async taggedConflictLock() {
    const directory = project("tagged-conflict-lock", { name: "install-fixture", dependencies: { versioned: "1.0.0", "uses-latest": "1.0.0" } });
    registry.latest.set("versioned", "2.0.0");
    await bun(directory, ["install"]);
    assert.equal(installed(directory, "versioned").version, "1.0.0");
    assert.equal(installed(directory, "uses-latest/node_modules/versioned").version, "2.0.0");
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    await bun(directory, ["install", "--frozen-lockfile"]);
    assert.equal(installed(directory, "versioned").version, "1.0.0");
    assert.equal(installed(directory, "uses-latest/node_modules/versioned").version, "2.0.0");
    const result = await bun(directory, ["-e", "console.log(require('versioned'), require('uses-latest'))"]);
    assert.equal(result.stdout.trim(), "versioned@1.0.0 versioned@2.0.0");
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
  },
  async productionFrozenConflict() {
    const directory = project("production-frozen-conflict", { name: "install-fixture", dependencies: { "uses-one": "1.0.0" }, devDependencies: { versioned: "2.0.0" } });
    await bun(directory, ["install"]);
    assert.equal(installed(directory, "versioned").version, "2.0.0");
    const lock = readFileSync(join(directory, "bun.lock"), "utf8");
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
    await bun(directory, ["install", "--production", "--frozen-lockfile"]);
    const result = await bun(directory, ["-e", "console.log(require('uses-one'))"]);
    assert.equal(result.stdout.trim(), "versioned@1.1.0");
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
  },
  async rehoistedTaggedParent() {
    const directory = project("rehoisted-tagged-parent", { name: "install-fixture", dependencies: { "rehoist-parent": "1.0.0", "uses-rehoist-parent": "1.0.0" } });
    registry.latest.set("rehoist-child", "1.0.0");
    await bun(directory, ["install"]);
    assert.equal(installed(directory, "rehoist-parent").version, "1.0.0");
    assert.equal(installed(directory, "uses-rehoist-parent/node_modules/rehoist-parent").version, "2.0.0");
    assert.equal(installed(directory, "rehoist-child").version, "1.0.0");
    registry.latest.set("rehoist-child", "2.0.0");
    // Clear cached metadata so a mistaken resolution cannot silently use the old dist tag.
    rmSync(join(directory, "cache"), { recursive: true, force: true });
    const before = registry.requests.length;
    await bun(directory, ["remove", "rehoist-parent"]);
    const metadata = registry.requests.slice(before).filter(request => !request.path.startsWith("/tarballs/"));
    assert.deepEqual(metadata, [], "moving a locked package fetched new registry metadata");
    assert.deepEqual(manifest(directory).dependencies, { "uses-rehoist-parent": "1.0.0" });
    assert.equal(installed(directory, "rehoist-parent").version, "2.0.0");
    assert.equal(installed(directory, "rehoist-child").version, "1.0.0");
    const result = await bun(directory, ["-e", "console.log(require('rehoist-parent'), require('uses-rehoist-parent'))"]);
    assert.equal(result.stdout.trim(), "rehoist-child@1.0.0 rehoist-child@1.0.0");
    assert.doesNotMatch(readFileSync(join(directory, "bun.lock"), "utf8"), /rehoist-child@2\.0\.0/);
  },
};

let passed = 0, failed = 0, skipped = 0;
try {
  registry = await createRegistry();
  const wanted = process.env.INSTALL_CASES?.split(",") ?? Object.keys(cases);
  for (const name of wanted) {
    if (process.env.INSTALL_NATIVE_BUN === "1" && ["idleTimeout", "wasmDistributions"].includes(name)) {
      console.log(`skip ${name} (bun-wasm platform check)`); skipped++; continue;
    }
    try { assert.ok(cases[name], `unknown install case ${name}`); await cases[name](); console.log(`ok ${name}`); passed++; }
    catch (error) { console.error(`FAIL ${name}\n${error.stack}`); failed++; }
  }
  console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}; ${registry.requests.length} local registry requests`);
} finally {
  await cleanup();
}
process.exitCode = failed ? 1 : 0;
