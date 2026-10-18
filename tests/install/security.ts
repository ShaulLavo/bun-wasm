import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageFixture } from "./registry.mjs";

type CapturedRequest = { url: string; authorization: string | null };
type Result = { code: number | null; stdout: string; stderr: string };
const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync("/work/tmp/bun-wasm-install-security-");
const evidence = process.env.INSTALL_SECURITY_EVIDENCE;
const secret = "fixture-private-secret";
const configuredSecret = "fixture-configured-secret";
const fixture = packageFixture("security-dep", "1.0.0");
const children = new Set<ReturnType<typeof spawn>>();
let requests: CapturedRequest[] = [];
let tarballMode = "plain";
let failure = "";
let integrity = fixture.integrity;
let corrupt = false;
let base = "";
const outside = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
  requests.push({ url: request.url, authorization: request.headers.get("authorization") });
  return new Response(Uint8Array.from(fixture.archive).buffer);
} });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response | Promise<Response> {
  requests.push({ url: request.url, authorization: request.headers.get("authorization") });
  const archive = new URL(request.url).pathname.endsWith(".tgz");
  if (failure === (archive ? "archive-timeout" : "metadata-timeout")) return new Promise<Response>(() => {});
  if (failure === (archive ? "archive-status" : "metadata-status")) return new Response("fixture failure", { status: 503 });
  if (archive) return new Response(corrupt ? new Uint8Array([0, 1, 2]).buffer : Uint8Array.from(fixture.archive).buffer);
  let tarball = base + "/archives/security-dep-1.0.0.tgz";
  if (tarballMode === "userinfo") tarball = tarball.replace("://", `://fixture-user:${secret}@`);
  if (tarballMode === "query") tarball += `?authToken=${secret}`;
  if (tarballMode === "external") tarball = String(outside.url) + "security-dep.tgz";
  const extra = tarballMode === "optional-range" ? { optionalDependencies: { missing: `https://fixture-user:${secret}@other.invalid/missing.tgz` } } : {};
  return Response.json({ name: "security-dep", versions: { "1.0.0": { ...fixture.manifest, ...extra, dist: { tarball, integrity } } } });
} });
base = String(server.url).replace(/\/$/, "");
let closed = false;
async function cleanup() {
  if (closed) return;
  closed = true;
  const exits = Array.from(children, child => new Promise<void>(done => child.once("close", () => done())));
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(exits);
  await server.stop(true);
  await outside.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
function project(name: string) {
  const cwd = join(scratch, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "security-review", dependencies: { "security-dep": "1.0.0" } }));
  return cwd;
}
function foreignLock(cwd: string, sri: string) {
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": manifest, "node_modules/security-dep": { version: "1.0.0", resolved: base + "/archives/security-dep-1.0.0.tgz", integrity: sri } } }));
}
async function run(cwd: string, args: string[], registry: string | null = base, native = false): Promise<Result> {
  const environment: Record<string, string | undefined> = { ...process.env, HOME: cwd, BUN_INSTALL_CACHE_DIR: join(cwd, "cache"), BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" };
  for (const name of ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"]) delete environment[name];
  if (registry !== null) environment.NPM_CONFIG_REGISTRY = registry;
  const options = ["--wasm", resolve(root, process.env.BUN_WASM ?? "dist/bun.wasm"), "--dir", `${cwd}::/`, "--env", "PWD=/", "--env", "HOME=/", "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=1"];
  if (registry !== null) options.push("--env", `NPM_CONFIG_REGISTRY=${registry}`);
  options.push("--");
  const browser = process.env.INSTALL_ENGINE === "browser";
  const executable = native ? process.env.NATIVE_BUN ?? "bun" : browser ? "node" : process.env.BUN_WASM_LAUNCHER ?? "/work/tmp/bun-wasm-target/release/bun-wasm";
  const argv = native ? args : (browser ? [join(root, "web/scripts/node-host.mjs"), "--net"].concat(options) : options).concat(args);
  const child = spawn(executable, argv, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout?.on("data", bytes => { stdout += bytes; }); child.stderr?.on("data", bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try { return { code: await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); }), stdout, stderr }; }
  finally { clearTimeout(timer); children.delete(child); }
}
function checkSecrets(cwd: string, result: Result) {
  assert.equal(result.stdout.includes(secret), false, "stdout exposed URL credentials");
  assert.equal(result.stderr.includes(secret), false, "stderr/error exposed URL credentials");
  assert.equal((result.stdout + result.stderr).includes(configuredSecret), false, "configured authorization appeared in diagnostics");
  if (existsSync(join(cwd, "bun.lock"))) assert.equal(readFileSync(join(cwd, "bun.lock"), "utf8").includes(secret), false, "lock exposed URL credentials");
  for (const request of requests) {
    assert.equal(request.url.includes(secret), false, "request URL exposed credentials");
    assert.equal(request.authorization, null, "URL credentials produced an authorization header");
  }
}
async function credentials(name: string, mode: string, error = "") {
  requests = []; tarballMode = mode === "tarball-query" ? "query" : mode.startsWith("tarball") ? "userinfo" : mode === "optional-range" ? mode : "plain"; failure = error;
  const cwd = project(name);
  let registry: string | null = mode.startsWith("registry") ? base.replace("://", `://fixture-user:${secret}@`) : base;
  if (mode === "registry-query") registry = base + `/?token=${secret}`;
  if (mode === "registry-cli") { registry = null; }
  if (mode === "registry-config") { writeFileSync(join(cwd, "bunfig.toml"), `[install]\nregistry = ${JSON.stringify(registry)}\n`); registry = null; }
  if (mode === "registry-malformed") registry = `http://fixture-user:${secret}@invalid host`;
  if (mode === "frozen" || mode === "legacy-lock") {
    foreignLock(cwd, fixture.integrity);
    const migration = await run(cwd, ["pm", "migrate"]); assert.equal(migration.code, 0, migration.stderr);
    rmSync(join(cwd, "package-lock.json"));
    const transport = mode === "frozen" ? "" : base.replace("://", `://fixture-user:${secret}@`) + "/archives/security-dep-1.0.0.tgz";
    const lock = readFileSync(join(cwd, "bun.lock"), "utf8").replace(JSON.stringify(base + "/archives/security-dep-1.0.0.tgz"), JSON.stringify(transport));
    writeFileSync(join(cwd, "bun.lock"), lock);
    registry = mode === "frozen" ? base.replace("://", `://fixture-user:${secret}@`) : base;
    requests = [];
  }
  const args = ["install", ...(mode === "frozen" ? ["--frozen-lockfile"] : [])];
  if (mode === "registry-cli") args.push("--registry", base.replace("://", `://fixture-user:${secret}@`));
  const result = await run(cwd, args, registry);
  checkSecrets(cwd, result);
  const rejected = error !== "" || mode.includes("query") || mode.includes("malformed") || mode === "optional-range";
  assert.equal(result.code === 0, !rejected, "unexpected install result");
  if (mode === "registry-query" || mode === "registry-malformed") assert.equal(requests.length, 0);
  if (mode === "tarball-query") assert.equal(requests.filter(row => row.url.endsWith(".tgz")).length, 0);
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${name}.json`), JSON.stringify({ result, requests }, null, 2));
  }
  if (!rejected) assert.equal(JSON.parse(readFileSync(join(cwd, "node_modules/security-dep/package.json"), "utf8")).version, "1.0.0");
}
async function configuredAuth(mode = "bearer") {
  requests = []; failure = mode === "status" ? "metadata-status" : ""; tarballMode = mode === "external" ? "external" : "plain";
  const cwd = project(`configured-auth-${mode}`);
  const credentials = mode === "basic" ? `username = "fixture-user"\npassword = ${JSON.stringify(configuredSecret)}` : `token = ${JSON.stringify(configuredSecret)}`;
  writeFileSync(join(cwd, "bunfig.toml"), `[install.registry]\nurl = ${JSON.stringify(base)}\n${credentials}\n`);
  const result = await run(cwd, ["install"], null);
  assert.equal((result.stdout + result.stderr).includes(configuredSecret), false);
  assert.equal(result.code === 0, mode !== "status", result.stderr);
  assert.ok(requests.length > 0);
  const expected = mode === "basic" ? `Basic ${Buffer.from(`fixture-user:${configuredSecret}`).toString("base64")}` : `Bearer ${configuredSecret}`;
  for (const request of requests) assert.equal(request.authorization, request.url.startsWith(base + "/") ? expected : null);
  if (existsSync(join(cwd, "bun.lock"))) assert.equal(readFileSync(join(cwd, "bun.lock"), "utf8").includes(configuredSecret), false);
  if (evidence) {
    const captures = requests.map(request => ({ url: request.url, authorization: request.authorization ? "configured" : null }));
    mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, `configured-${mode}.json`), JSON.stringify({ result, requests: captures }, null, 2));
  }
}

async function hashCase(algorithm: string) {
  requests = []; failure = ""; tarballMode = "plain"; corrupt = false;
  const sri = `${algorithm}-${createHash(algorithm).update(fixture.archive).digest("base64")}`;
  const native = project(`hash-${algorithm}-native`), guest = project(`hash-${algorithm}-guest`);
  foreignLock(native, sri); foreignLock(guest, sri);
  for (const [cwd, isNative] of [[native, true], [guest, false]] satisfies [string, boolean][]) {
    const migration = await run(cwd, ["pm", "migrate"], base, isNative); assert.equal(migration.code, 0, migration.stderr);
  }
  const expected = readFileSync(join(native, "bun.lock"), "utf8"), actual = readFileSync(join(guest, "bun.lock"), "utf8");
  if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, `${algorithm}-native.lock`), expected); writeFileSync(join(evidence, `${algorithm}-guest.lock`), actual); }
  for (const [cwd, isNative] of [[native, true], [guest, false]] satisfies [string, boolean][]) {
    const install = await run(cwd, ["install", "--frozen-lockfile"], base, isNative); assert.equal(install.code, 0, install.stderr);
    assert.equal(readFileSync(join(cwd, "bun.lock"), "utf8"), expected);
    rmSync(join(cwd, "node_modules"), { recursive: true, force: true }); rmSync(join(cwd, "cache"), { recursive: true, force: true });
  }
  assert.equal(actual, expected, `${algorithm} lock differs from native Bun`);
  corrupt = true;
  try {
    const rejected = await run(guest, ["install", "--frozen-lockfile"]); assert.notEqual(rejected.code, 0); assert.match(rejected.stderr, /integrity/i);
  } finally { corrupt = false; }
}
const cases: [string, () => Promise<void>][] = [
  ["registry-env", () => credentials("registry-env", "registry")],
  ["registry-cli", () => credentials("registry-cli", "registry-cli")],
  ["registry-config", () => credentials("registry-config", "registry-config")],
  ["registry-status", () => credentials("registry-status", "registry", "metadata-status")],
  ["registry-timeout", () => credentials("registry-timeout", "registry", "metadata-timeout")],
  ["registry-malformed", () => credentials("registry-malformed", "registry-malformed")],
  ["registry-query", () => credentials("registry-query", "registry-query")],
  ["tarball-userinfo", () => credentials("tarball-userinfo", "tarball")],
  ["tarball-status", () => credentials("tarball-status", "tarball", "archive-status")],
  ["tarball-timeout", () => credentials("tarball-timeout", "tarball", "archive-timeout")],
  ["tarball-query", () => credentials("tarball-query", "tarball-query")],
  ["frozen-registry", () => credentials("frozen-registry", "frozen")],
  ["legacy-lock-userinfo", () => credentials("legacy-lock-userinfo", "legacy-lock")],
  ["configured-auth", () => configuredAuth()],
  ["configured-basic", () => configuredAuth("basic")],
  ["configured-status", () => configuredAuth("status")],
  ["configured-external", () => configuredAuth("external")],
  ["optional-range-redaction", () => credentials("optional-range", "optional-range")],
  ["sha256", () => hashCase("sha256")],
  ["sha384", () => hashCase("sha384")],
];
try {
  for (const [name, check] of cases) {
    if (process.env.INSTALL_SECURITY_CASES && !process.env.INSTALL_SECURITY_CASES.split(",").includes(name)) continue;
    try { await check(); console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
  }
} finally { await cleanup(); }
