import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry } from "./registry.mjs";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), "bun-wasm-package-options-"));
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
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

async function run(directory: string, args: string[], code = 0, path?: string) {
  assert.ok(registry);
  const engine = process.env.INSTALL_ENGINE ?? "quickjs";
  const native = process.env.INSTALL_NATIVE_BUN === "1";
  const wasm = resolve(root, "dist", engine === "quickjs" ? "bun.wasm" : `bun-${engine}.wasm`);
  const executable = native ? process.execPath : engine === "browser" ? Bun.which("node") : process.env.BUN_WASM_LAUNCHER;
  assert.ok(executable, "Set BUN_WASM_LAUNCHER for embedded engines");
  const guest = ["--wasm", wasm, "--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${registry.base}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache"].concat(path === undefined ? [] : ["--env", `PATH=${path}`], ["--"], args);
  const argv = native ? args : engine === "browser" ? ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(guest) : guest;
  const env: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_REGISTRY: registry.base, BUN_INSTALL_CACHE_DIR: join(directory, "cache") };
  delete env.PATH;
  if (path !== undefined) env.PATH = path;
  const child = spawn(executable, argv, { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout?.on("data", bytes => { stdout += bytes; });
  child.stderr?.on("data", bytes => { stderr += bytes; });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60000);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => { clearTimeout(deadline); children.delete(child); });
  assert.equal(status, code, `${args.join(" ")}\n${stdout}${stderr}`);
  return { stdout, stderr };
}

function contents(directory: string, name = "package.json") {
  return readFileSync(join(directory, name), "utf8");
}

async function lockOnly() {
  assert.ok(registry);
  registry.latest.set("versioned", "1.1.0");
  const directory = project("lock-only", { name: "root", dependencies: { versioned: ">=1 1", "uses-one": "1.0.0" }, overrides: { "versioned@^99999999999999999999": "2.0.0" } });
  const before = contents(directory);
  const start = registry.requests.length;
  await run(directory, ["install", "--lockfile-only"]);
  assert.equal(contents(directory), before);
  assert.equal(existsSync(join(directory, "node_modules")), false);
  assert.ok(registry.requests.length > start, "lock-only resolves registry metadata");
  assert.ok(registry.requests.slice(start).every(request => !request.path.startsWith("/tarballs/")), "lock-only must not fetch payloads");
  const lock = contents(directory, "bun.lock");
  assert.match(lock, /versioned@1\.1\.0/);
  mkdirSync(join(directory, "node_modules"));
  writeFileSync(join(directory, "node_modules", "sentinel"), "preserve");
  await run(directory, ["install", "--lockfile-only", "--frozen-lockfile"]);
  assert.equal(contents(directory, "bun.lock"), lock);
  assert.equal(contents(directory, "node_modules/sentinel"), "preserve");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { versioned: "2.0.0" } }));
  const changed = contents(directory);
  const result = await run(directory, ["install", "--lockfile-only", "--frozen-lockfile"], 1);
  assert.match(result.stderr, /lockfile.*frozen/);
  assert.equal(contents(directory, "bun.lock"), lock);
  assert.equal(contents(directory), changed);
  assert.equal(contents(directory, "node_modules/sentinel"), "preserve");
  writeFileSync(join(directory, "package.json"), before);
  await run(directory, ["install", "--frozen-lockfile"]);
  assert.equal(JSON.parse(contents(directory, "node_modules/versioned/package.json")).version, "1.1.0");
  assert.equal(contents(directory, "bun.lock"), lock);
}

async function missingVersion() {
  assert.ok(registry);
  const directory = project("missing-version", { dependencies: { versioned: "^99999999999999999999" } });
  const before = contents(directory);
  const start = registry.requests.length;
  const result = await run(directory, ["install"], 1);
  assert.ok(result.stderr.includes('error: No version matching "^99999999999999999999" found for specifier "versioned" (but package exists)'));
  assert.deepEqual(registry.requests.slice(start).map(request => request.path), ["/versioned"]);
  assert.equal(contents(directory), before);
  assert.equal(existsSync(join(directory, "bun.lock")), false);
  assert.equal(existsSync(join(directory, "node_modules")), false);
}

async function invalidVersion() {
  const rows = [
    { version: "1.0.18446744073709551616", arg: "patch", stderr: 'error: Current version "1.0.18446744073709551616" is not a valid semver\n' },
    { version: "1.0.0", arg: "1.0.18446744073709551616", stderr: 'error: Invalid version argument: "1.0.18446744073709551616"\nnote: Valid options: patch, minor, major, prepatch, preminor, premajor, prerelease, from-git, or a specific semver version\n' },
  ];
  for (const invalid of ["9007199254740992.0.0", "1.2"]) {
    rows.push({ version: invalid, arg: "patch", stderr: `error: Current version "${invalid}" is not a valid semver\n` });
    rows.push({ version: "1.0.0", arg: invalid, stderr: `error: Invalid version argument: "${invalid}"\nnote: Valid options: patch, minor, major, prepatch, preminor, premajor, prerelease, from-git, or a specific semver version\n` });
  }
  for (const [index, row] of rows.entries()) {
    const directory = project(`invalid-version-${index}`, { name: "root", version: row.version });
    const before = contents(directory);
    const result = await run(directory, ["pm", "version", row.arg, "--no-git-tag-version"], 1);
    assert.deepEqual(result, { stdout: "", stderr: row.stderr });
    assert.equal(contents(directory), before);
    assert.equal(existsSync(join(directory, "bun.lock")), false);
  }
}

async function validVersion() {
  const directory = project("valid-version", { name: "root", version: "1.2.3" });
  const rows: [string, string][] = [["patch", "1.2.4"], ["minor", "1.3.0"], ["major", "2.0.0"], ["v3.4.5-rc.1+build", "3.4.5-rc.1"], ["patch", "3.4.5"]];
  for (const [arg, expected] of rows) {
    const result = await run(directory, ["pm", "version", arg, "--no-git-tag-version"]);
    assert.equal(result.stdout, `v${expected}\n`);
    assert.equal(JSON.parse(contents(directory)).version, expected);
  }
  const before = contents(directory);
  const dry = await run(directory, ["pm", "version", "minor", "--no-git-tag-version", "--dry-run"]);
  assert.equal(dry.stdout, "v3.5.0\n");
  assert.equal(contents(directory), before);
  const same = await run(directory, ["pm", "version", "3.4.5", "--no-git-tag-version"], 1);
  assert.equal(same.stderr, "error: Version not changed\n");
  assert.equal(contents(directory), before);
  assert.equal(existsSync(join(directory, "bun.lock")), false);
  assert.equal(existsSync(join(directory, "node_modules")), false);
}

async function scriptPathCase(directory: string, entry: string, path: string | undefined) {
  if (entry === "probe" && (path === "" || path === "/restricted") && process.env.INSTALL_NATIVE_BUN !== "1") {
    const result = await run(directory, ["run", entry], 1, path);
    assert.equal(result.stdout, "", "a missing runtime must not reach the PATH probe");
    assert.match(result.stderr, /spawn bun ENOENT/);
    return;
  }
  const result = await run(directory, ["run", entry], 0, path);
  const value = JSON.parse(result.stdout);
  if (path === undefined || path === "/bin:/usr/bin") {
    assert.ok(value.node, `node must be on the default/inherited path: ${result.stdout}`);
    assert.equal(value.output, "path-child");
    return;
  }
  if (process.env.INSTALL_NATIVE_BUN === "1") {
    assert.match(value.node, /^\/tmp\/bun-node-[^/]+\/node$/);
    assert.equal(value.output, "path-child");
    assert.ok(value.path.endsWith(`:${path}`));
    assert.equal(value.path.split(":").includes("/bin"), false);
    assert.equal(value.path.split(":").includes("/usr/bin"), false);
    return;
  }
  assert.equal(value.node, null, `explicit PATH must not acquire a default: ${result.stdout}`);
  assert.equal(value.output, "");
  assert.ok(value.path.endsWith(path));
}

async function scriptPath() {
  const runtime = process.env.INSTALL_NATIVE_BUN === "1" ? process.execPath : "/bin/bun";
  const directory = project("script-path", { scripts: { probe: "bun probe.ts", explicit: `${JSON.stringify(runtime)} probe.ts` } });
  writeFileSync(join(directory, "probe.ts"), `
    const result = { path: process.env.PATH, node: Bun.which("node"), output: "" };
    try { result.output = new TextDecoder().decode(Bun.spawnSync(["node", "-e", "console.log('path-child')"]).stdout).trim(); } catch {}
    console.log(JSON.stringify(result));
  `);
  for (const entry of ["probe.ts", "probe", "explicit"]) {
    for (const path of [undefined, "", "/restricted", "/bin:/usr/bin"]) {
      await scriptPathCase(directory, entry, path);
    }
  }
}

const cases = { lockOnly, missingVersion, invalidVersion, validVersion, scriptPath };
let failed = 0;
try {
  registry = await createRegistry();
  for (const [name, test] of Object.entries(cases)) {
    try { await test(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
  }
  console.log(`${Object.keys(cases).length - failed} passed, ${failed} failed; ${registry.requests.length} local registry requests`);
} finally {
  await cleanup();
}
process.exitCode = failed ? 1 : 0;
