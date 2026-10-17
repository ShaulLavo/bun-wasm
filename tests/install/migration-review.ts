import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packageFixture } from "./registry.mjs";

type Manifest = Record<string, unknown>;
type Fixture = ReturnType<typeof packageFixture>;
type Scenario = { name: string; manifest: Manifest; files: Record<string, string>; packages: Fixture[]; reject?: RegExp; unsupported?: RegExp; install?: boolean; env?: Record<string, string>; registry?: string; noArchives?: boolean; upstream?: string };
const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync("/work/tmp/bun-wasm-migration-review-");
const evidence = process.env.MIGRATION_EVIDENCE;
const children = new Set<ReturnType<typeof spawn>>();
const archives = new Map<string, Uint8Array>();
const metadata = new Map<string, Record<string, unknown>>();
let requests: string[] = [];
let base = "";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push(path);
  if (archives.has(path)) return new Response(archives.get(path));
  const name = decodeURIComponent(path.slice(1));
  return metadata.has(name) ? Response.json({ name, versions: metadata.get(name) }) : new Response("fixture unavailable", { status: 404 });
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
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
function json(value: unknown) { return JSON.stringify(value, null, 2); }
function yaml(value: unknown) { return Bun.YAML.stringify(value, null, 2); }
function pkg(name: string, version: string, extra: Manifest = {}) { return packageFixture(name, version, extra); }
function npm(manifest: Manifest, rows: Record<string, unknown>) { return { "package-lock.json": json({ lockfileVersion: 3, packages: { "": manifest, ...rows } }) }; }
function npmRow(p: Fixture, transport = `${base}/${p.manifest.name}/-/${p.manifest.name.split("/").at(-1)}-${p.manifest.version}.tgz`) { return { ...p.manifest, resolved: transport, integrity: p.integrity }; }
function pnpm(manifest: Manifest, packages: Fixture[], selections?: Record<string, unknown>) {
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([name, specifier]) => [name, { specifier, version: packages.find(p => p.manifest.name === name)?.manifest.version }]));
  const rows = Object.fromEntries(packages.map(p => [`${p.manifest.name}@${p.manifest.version}`, { resolution: { integrity: p.integrity } }]));
  const snapshots = Object.fromEntries(packages.map(p => [`${p.manifest.name}@${p.manifest.version}`, { dependencies: p.manifest.dependencies, optionalDependencies: p.manifest.optionalDependencies }]));
  return { "pnpm-lock.yaml": yaml({ lockfileVersion: "9.0", importers: { ".": { dependencies: selections ?? dependencies } }, packages: rows, snapshots }) };
}
function berry(manifest: Manifest, packages: Fixture[], selectors: Record<string, string> = {}) {
  const rows: Record<string, unknown> = { __metadata: { version: 8 }, "review@workspace:.": { version: "0.0.0-use.local", resolution: "review@workspace:.", dependencies: manifest.dependencies } };
  for (const p of packages) rows[`${p.manifest.name}@npm:${selectors[p.manifest.name + "@" + p.manifest.version] ?? p.manifest.version}`] = { ...p.manifest, resolution: `${p.manifest.name}@npm:${p.manifest.version}` };
  return { "yarn.lock": yaml(rows) };
}
function scenarios(): Scenario[] {
  const dep = pkg("dep", "1.0.0"), dep2 = pkg("dep", "1.0.1");
  const manifest = { name: "review", dependencies: { dep: "1.0.0" } };
  const a1 = pkg("a", "1.0.0", { dependencies: { b: "1.0.0" } }), b1 = pkg("b", "1.0.0", { dependencies: { a: "1.0.0" } });
  const cycle = [pkg("a", "2.0.0"), pkg("b", "2.0.0"), pkg("holder", "1.0.0", { dependencies: { a: "1.0.0" } }), a1, b1];
  const cycleManifest = { name: "review", dependencies: { a: "2.0.0", b: "2.0.0", holder: "1.0.0" } };
  const workspace = { name: "review", workspaces: ["packages/*"], dependencies: { member: "^1.0.0" } };
  const workspaceFiles = { "packages/member/package.json": json({ name: "member", version: "1.0.0" }) };
  const optional = pkg("parent", "1.0.0", { optionalDependencies: { dep: "1.0.0" } });
  const optionalManifest = { name: "review", dependencies: { parent: "1.0.0" } };
  const optionalFiles = berry(optionalManifest, [optional, dep]);
  const optionalRows = Bun.YAML.parse(optionalFiles["yarn.lock"]);
  optionalRows["parent@npm:1.0.0"].dependencies = { dep: "1.0.0" };
  optionalRows["parent@npm:1.0.0"].dependenciesMeta = { dep: { optional: true } };
  delete optionalRows["parent@npm:1.0.0"].optionalDependencies;
  optionalFiles["yarn.lock"] = yaml(optionalRows);
  const resolutionManifest = { name: "review", dependencies: { dep: "1.0.0", parent: "1.0.0" }, resolutions: { "parent/dep": "1.0.1" } };
  const parent = pkg("parent", "1.0.0", { dependencies: { dep: "^1.0.0" } });
  return [
    { name: "npm-workspace-nested", manifest: {}, files: {}, packages: [], upstream: "npm-arborist/workspaces-conflicting-versions-virtual" },
    { name: "pnpm-nested-cycle", manifest: cycleManifest, files: pnpm(cycleManifest, cycle), packages: cycle, install: true },
    { name: "berry-nested-cycle", manifest: cycleManifest, files: berry(cycleManifest, cycle), packages: cycle, install: true },
    { name: "berry-workspace-semver", manifest: workspace, files: { ...berry(workspace, []), ...workspaceFiles }, packages: [], install: true },
    { name: "pnpm-dangling-link", manifest, files: pnpm(manifest, [], { dep: { specifier: "1.0.0", version: "link:missing" } }), packages: [], reject: /(?:not found|non-existent|MissingPackage|missing package|InvalidPnpm)/i },
    { name: "npm-custom-default-transport", manifest, files: npm(manifest, { "node_modules/dep": npmRow(dep, "https://registry.npmjs.org/custom/dep-1.0.0.tgz") }), packages: [dep] },
    { name: "npm-custom-registry-transport", manifest, files: npm(manifest, { "node_modules/dep": npmRow(dep) }), packages: [dep], install: true },
    { name: "npm-unverified-external", manifest, files: npm(manifest, { "node_modules/dep": { version: "1.0.0", resolved: "http://127.0.0.1:1/dep.tgz" } }), packages: [], reject: /InvalidNPMLockfile/, noArchives: true },
    { name: "berry-registry-mismatch", manifest, files: { ...berry(manifest, [dep]), ".yarnrc.yml": 'npmRegistryServer: "https://other.invalid"\n' }, packages: [dep], reject: /yarn fetches.*configured to fetch/i, noArchives: true },
    { name: "berry-registry-env-mismatch", manifest, files: berry(manifest, [dep]), packages: [dep], env: { YARN_NPM_REGISTRY_SERVER: "https://other.invalid" }, reject: /yarn fetches.*configured to fetch/i, noArchives: true },
    { name: "berry-scoped-registry-mismatch", manifest: { name: "review", dependencies: { "@scope/dep": "1.0.0" } }, files: { ...berry({ dependencies: { "@scope/dep": "1.0.0" } }, [pkg("@scope/dep", "1.0.0")]), ".yarnrc.yml": 'npmScopes:\n  scope:\n    npmRegistryServer: "https://other.invalid"\n' }, packages: [pkg("@scope/dep", "1.0.0")], reject: /yarn fetches.*configured to fetch/i },
    { name: "berry-parent-resolution", manifest: resolutionManifest, files: berry(resolutionManifest, [dep, dep2, parent]), packages: [dep, dep2, parent], unsupported: /(?:resolutions|selection).*not supported/i },
    { name: "npm-overrides", manifest: { ...manifest, overrides: { dep: "1.0.0" } }, files: npm(manifest, { "node_modules/dep": npmRow(dep) }), packages: [dep], unsupported: /(?:overrides|selection).*not supported/i },
    { name: "berry-optional", manifest: optionalManifest, files: optionalFiles, packages: [optional, dep], install: true },
    { name: "npm-invalid-version", manifest, files: npm(manifest, { "node_modules/dep": { ...npmRow(dep), version: "not-a-version" } }), packages: [dep], reject: /InvalidNPMLockfile/ },
    { name: "berry-invalid-resolution-version", manifest, files: { "yarn.lock": berry(manifest, [dep])["yarn.lock"].replace('resolution: dep@npm:1.0.0', 'resolution: dep@npm:^1.0.0') }, packages: [dep], reject: /(?:version|resolution|semver)/i },
    { name: "npm-unsupported-schema", manifest, files: { "package-lock.json": json({ lockfileVersion: 99, packages: { "": manifest } }) }, packages: [], reject: /lockfileVersion 99.*cannot migrate/ },
    { name: "pnpm-stale-importer", manifest: { name: "review", dependencies: { dep: "^2.0.0" } }, files: pnpm({ dependencies: { dep: "^1.0.0" } }, [dep]), packages: [dep], reject: /(?:specifier|package.json|outdated|stale)/i },
    { name: "berry-credential-diagnostic", manifest: { name: "review", dependencies: { dep: "https://synthetic-user:synthetic-secret@other.invalid/dep.tgz" } }, files: berry(manifest, [dep]), packages: [], reject: /(?:resolution|pin|protocol)/i },
    { name: "berry-registry-credentials", manifest, files: berry(manifest, [dep]), packages: [dep], registry: base.replace("://", "://synthetic-user:synthetic-secret@") },
  ];
}
async function run(cwd: string, native: boolean, scenario: Scenario, ...args: string[]) {
  const registry = scenario.registry ?? base;
  const environment = { HOME: cwd, BUN_INSTALL_CACHE_DIR: join(cwd, "cache"), NPM_CONFIG_REGISTRY: registry, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1", ...scenario.env };
  const options = ["--wasm", resolve(root, process.env.BUN_WASM ?? "dist/bun.wasm"), "--dir", `${cwd}::/`, "--env", "PWD=/", "--env", "HOME=/", "--env", "BUN_INSTALL_CACHE_DIR=/cache"];
  for (const [name, value] of Object.entries(environment)) if (name !== "HOME" && name !== "BUN_INSTALL_CACHE_DIR") options.push("--env", `${name}=${value}`);
  options.push("--");
  const browser = process.env.INSTALL_ENGINE === "browser";
  const exe = native ? process.env.NATIVE_BUN ?? "bun" : browser ? "node" : process.env.BUN_WASM_LAUNCHER!;
  const argv = native ? args : (browser ? [join(root, "web/scripts/node-host.mjs"), "--net"].concat(options) : options).concat(args);
  const child = spawn(exe, argv, { cwd, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout?.on("data", bytes => { output += bytes; }); child.stderr?.on("data", bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try { return { code: await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); }), output }; }
  finally { clearTimeout(timer); children.delete(child); }
}
function writeFiles(directory: string, scenario: Scenario) {
  mkdirSync(directory, { recursive: true });
  if (scenario.upstream) { cpSync(join(root, "vendor/bun/test/cli/install/migration", scenario.upstream), directory, { recursive: true }); return; }
  for (const [file, bytes] of Object.entries({ "package.json": json(scenario.manifest), ...scenario.files })) {
    mkdirSync(dirname(join(directory, file)), { recursive: true }); writeFileSync(join(directory, file), bytes);
  }
}
async function check(scenario: Scenario) {
  archives.clear(); metadata.clear(); requests = [];
  for (const p of scenario.packages) {
    const path = `/${p.manifest.name}/-/${p.manifest.name.split("/").at(-1)}-${p.manifest.version}.tgz`;
    archives.set(path, p.archive);
    const versions = metadata.get(p.manifest.name) ?? {};
    versions[p.manifest.version] = { ...p.manifest, dist: { integrity: p.integrity, tarball: base + path } }; metadata.set(p.manifest.name, versions);
  }
  const reference = join(scratch, scenario.name, "native"), guest = join(scratch, scenario.name, "guest");
  writeFiles(reference, scenario); cpSync(reference, guest, { recursive: true });
  const native = await run(reference, true, scenario, "pm", "migrate");
  const actual = await run(guest, false, scenario, "pm", "migrate");
  const nativeLock = existsSync(join(reference, "bun.lock")) ? readFileSync(join(reference, "bun.lock"), "utf8") : undefined;
  const guestLock = existsSync(join(guest, "bun.lock")) ? readFileSync(join(guest, "bun.lock"), "utf8") : undefined;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${scenario.name}.json`), json({ native, actual, requests }));
    if (nativeLock) writeFileSync(join(evidence, `${scenario.name}-native.lock`), nativeLock);
    if (guestLock) writeFileSync(join(evidence, `${scenario.name}-guest.lock`), guestLock);
  }
  assert.doesNotMatch(actual.output + (guestLock ?? ""), /synthetic-secret|synthetic-user/);
  if (scenario.noArchives) assert.equal(requests.some(path => path.endsWith(".tgz")), false);
  if (scenario.reject || scenario.unsupported) {
    if (scenario.reject) { assert.notEqual(native.code, 0, `native accepted ${scenario.name}`); assert.match(native.output, scenario.reject); }
    assert.notEqual(actual.code, 0, actual.output); assert.match(actual.output, scenario.reject ?? scenario.unsupported!); assert.equal(guestLock, undefined);
    console.log(`PASS ${scenario.name}: rejected without publishing a lock`); return;
  }
  assert.equal(native.code, 0, native.output); assert.equal(actual.code, 0, actual.output);
  assert.equal(guestLock, nativeLock, `${scenario.name} native byte mismatch`);
  const frozen = await run(guest, false, scenario, "install", "--frozen-lockfile", ...(scenario.install ? [] : ["--lockfile-only"]));
  assert.equal(frozen.code, 0, frozen.output); assert.equal(readFileSync(join(guest, "bun.lock"), "utf8"), nativeLock);
  if (scenario.install && scenario.packages.length) {
    const name = Object.keys(scenario.manifest.dependencies ?? {})[0];
    const imported = await run(guest, false, scenario, "-e", `console.log(require(${JSON.stringify(name)}))`); assert.equal(imported.code, 0, imported.output);
  }
  console.log(`PASS ${scenario.name}: native bytes and ${scenario.install ? "actual frozen install" : "frozen lock writer"}`);
}
try {
  for (const scenario of scenarios()) {
    if (process.env.MIGRATION_CASES && !process.env.MIGRATION_CASES.split(",").includes(scenario.name)) continue;
    try { await check(scenario); } catch (error) { console.error(`FAIL ${scenario.name}`, error); process.exitCode = 1; }
  }
} finally { await cleanup(); }
