import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry, packageFixture } from "./registry.mjs";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), "bun-wasm-root-overrides-"));
const children = new Set<ReturnType<typeof spawn>>();
let registry: Awaited<ReturnType<typeof createRegistry>> | undefined;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of children) child.kill("SIGKILL");
  await registry?.close();
  rmSync(scratch, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

function project(name: string, manifest: object) {
  const directory = join(scratch, name);
  mkdirSync(directory);
  save(directory, manifest);
  return directory;
}

function save(directory: string, manifest: object) {
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function contents(directory: string, path = "bun.lock") {
  return readFileSync(join(directory, path), "utf8");
}

function installed(directory: string, name: string) {
  return JSON.parse(contents(directory, `node_modules/${name}/package.json`)).version;
}

async function run(directory: string, args: string[], expected = 0) {
  assert.ok(registry);
  const engine = process.env.INSTALL_ENGINE ?? "quickjs";
  const native = process.env.INSTALL_NATIVE_BUN === "1";
  const wasm = resolve(root, "dist", engine === "quickjs" ? "bun.wasm" : `bun-${engine}.wasm`);
  const executable = native ? process.execPath : engine === "browser" ? Bun.which("node") : process.env.BUN_WASM_LAUNCHER;
  assert.ok(executable, "Set BUN_WASM_LAUNCHER for embedded engines");
  const guest = ["--wasm", wasm, "--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${registry.base}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--"].concat(args);
  const argv = native ? args : engine === "browser" ? ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(guest) : guest;
  const child = spawn(executable, argv, { cwd: directory, env: { ...process.env, NPM_CONFIG_REGISTRY: registry.base, BUN_INSTALL_CACHE_DIR: join(directory, "cache") }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout?.on("data", bytes => { stdout += bytes; });
  child.stderr?.on("data", bytes => { stderr += bytes; });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => { clearTimeout(deadline); children.delete(child); });
  assert.equal(code, expected, `${args.join(" ")}\n${stdout}${stderr}`);
  return { stdout, stderr };
}

async function selectors() {
  const dependencies = { "selector-fits": "<2.0.0", "@fixture/selected": "<2.0.0", "selector-misses": "^2.0.0" };
  const overrides = { "selector-fits@^1.0.0": "0.5.0", "@fixture/selected@^1": "0.5.0", "selector-misses@^1": "0.5.0" };
  const directory = project("selectors", { name: "root", dependencies, overrides });
  await run(directory, ["install"]);
  assert.equal(installed(directory, "selector-fits"), "0.5.0");
  assert.equal(installed(directory, "@fixture/selected"), "0.5.0");
  assert.equal(installed(directory, "selector-misses"), "2.0.0");
  const lock = contents(directory);
  assert.ok(Bun.JSONC.parse(lock).overrides, "root overrides persist");
  rmSync(join(directory, "node_modules"), { recursive: true, force: true });
  await run(directory, ["install", "--frozen-lockfile"]);
  assert.equal(installed(directory, "selector-fits"), "0.5.0");
  assert.equal(contents(directory), lock);
}

async function invalidSelectors() {
  const rows = ["^99999999999999999999", "^1 || ^99999999999999999999", "latest", "", "^2"];
  for (const [index, selector] of rows.entries()) {
    const directory = project(`invalid-${index}`, { dependencies: { "selector-fits": "<2.0.0" }, overrides: { [`selector-fits@${selector}`]: "0.5.0" } });
    await run(directory, ["install", "--lockfile-only"]);
    assert.equal(Bun.JSONC.parse(contents(directory)).packages["selector-fits"][0], "selector-fits@1.0.0", selector);
    const lock = contents(directory);
    await run(directory, ["install", "--lockfile-only", "--frozen-lockfile"]);
    assert.equal(contents(directory), lock);
  }
}

async function skippedSelectors() {
  if (process.env.INSTALL_NATIVE_BUN === "1") return;
  for (const [index, selector] of ["^1 && <2", "1.2.3.4"].entries()) {
    const directory = project(`skipped-${index}`, { dependencies: { "selector-fits": "<2.0.0" }, overrides: { [`selector-fits@${selector}`]: "0.5.0" } });
    await run(directory, ["install", "--lockfile-only"]);
    assert.equal(Bun.JSONC.parse(contents(directory)).packages["selector-fits"][0], "selector-fits@1.0.0");
  }
}

async function transitive() {
  const directory = project("transitive", { dependencies: { "uses-one": "1.0.0", "uses-two": "1.0.0", "uses-latest": "1.0.0", "uses-scoped": "1.0.0" }, overrides: { versioned: "2.0.0", "@fixture/selected": "0.5.0" } });
  await run(directory, ["install"]);
  assert.equal(installed(directory, "versioned"), "2.0.0");
  assert.equal(installed(directory, "@fixture/selected"), "0.5.0");
  assert.equal(existsSync(join(directory, "node_modules/uses-one/node_modules/versioned")), false);
  const lock = contents(directory);
  await run(directory, ["install", "--frozen-lockfile"]);
  assert.equal(contents(directory), lock);
}

async function changed() {
  assert.ok(registry);
  registry.latest.set("versioned", "1.1.0");
  const dependencies = { "uses-one": "1.0.0", "uses-latest": "1.0.0", "selector-fits": "<2.0.0" };
  const directory = project("changed", { dependencies });
  await run(directory, ["install"]);
  assert.equal(installed(directory, "versioned"), "1.1.0");
  for (const overrides of [{ versioned: "2.0.0" }, { versioned: "1.0.0" }, { "versioned@^1": "1.0.0" }, {}]) {
    const lock = contents(directory);
    const previous = installed(directory, "versioned");
    save(directory, { dependencies, overrides });
    const manifest = contents(directory, "package.json");
    const before = registry.requests.length;
    const result = await run(directory, ["install", "--frozen-lockfile"], 1);
    assert.match(result.stderr, /lockfile.*frozen/);
    assert.equal(contents(directory), lock);
    assert.equal(contents(directory, "package.json"), manifest);
    assert.equal(installed(directory, "versioned"), previous);
    if (process.env.INSTALL_NATIVE_BUN !== "1") assert.ok(registry.requests.slice(before).every(request => !request.path.startsWith("/tarballs/")));
    const production = await run(directory, ["install", "--production", "--frozen-lockfile"], 1);
    assert.match(production.stderr, /lockfile.*frozen/);
    assert.equal(contents(directory), lock);
    await run(directory, ["install"]);
    const expected = "versioned" in overrides || "versioned@^1" in overrides ? "2.0.0" === overrides.versioned ? "2.0.0" : "1.0.0" : "1.1.0";
    assert.equal(installed(directory, "versioned"), expected);
    const saved = contents(directory);
    await run(directory, ["install", "--frozen-lockfile"]);
    assert.equal(contents(directory), saved);
  }
}

async function targets() {
  assert.ok(registry);
  registry.latest.set("versioned", "1.0.0");
  const directory = project("targets", { dependencies: { "selector-fits": "^1" }, overrides: { "selector-fits": "npm:versioned@2.0.0" } });
  await run(directory, ["install"]);
  assert.equal(installed(directory, "selector-fits"), "2.0.0");
  await run(directory, ["install", "--frozen-lockfile"]);
  const tagged = project("tag", { dependencies: { versioned: "^2" }, overrides: { versioned: "latest" } });
  await run(tagged, ["install"]);
  assert.equal(installed(tagged, "versioned"), "1.0.0");
  await run(tagged, ["install", "--frozen-lockfile"]);
}

try {
  const packages = ["selector-fits", "selector-misses", "@fixture/selected"].flatMap(name => ["0.5.0", "1.0.0", "2.0.0"].map(version => packageFixture(name, version)));
  registry = await createRegistry(packages.concat([packageFixture("uses-scoped", "1.0.0", { dependencies: { "@fixture/selected": "^1" } })]));
  for (const test of [selectors, invalidSelectors, skippedSelectors, transitive, changed, targets]) {
    if (process.env.INSTALL_CASE && process.env.INSTALL_CASE !== test.name) continue;
    await test();
    console.log(`PASS ${test.name}`);
  }
} finally {
  await cleanup();
}
