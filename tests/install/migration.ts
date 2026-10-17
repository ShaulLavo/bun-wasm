import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registry as replay } from "../../scripts/app-matrix/registry.mjs";

const root = resolve(import.meta.dir, "../..");
const upstream = join(root, "vendor/bun/test/cli/install/migration");
const scratch = mkdtempSync("/work/tmp/bun-wasm-migration-");
const evidence = process.env.MIGRATION_EVIDENCE;
const children = new Set<ReturnType<typeof spawn>>();
let mirror: Awaited<ReturnType<typeof replay>>;
let cleaned = false;
let registryOverride: string | undefined;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const exits = Array.from(children, child => new Promise<void>(resolve => child.once("close", () => resolve())));
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(exits);
  await mirror?.close();
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
async function run(cwd: string, native: boolean, ...args: string[]) {
  const engine = process.env.INSTALL_ENGINE;
  const registryBase = registryOverride || mirror.base;
  const options = ["--wasm", resolve(root, process.env.BUN_WASM || "dist/bun.wasm"), "--dir", `${cwd}::/`,
    "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${registryBase}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=2", "--"];
  const executable = native ? process.env.NATIVE_BUN || "bun" : engine === "browser" ? "node" : process.env.BUN_WASM_LAUNCHER!;
  const argv = native ? args : engine === "browser" ? [join(root, "web/scripts/node-host.mjs"), "--net"].concat(options, args) : options.concat(args);
  const child = spawn(executable, argv, { cwd, env: { ...process.env, HOME: cwd, BUN_INSTALL_CACHE_DIR: join(cwd, "cache"), NPM_CONFIG_REGISTRY: registryBase, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "2" }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout?.on("data", bytes => { output += bytes; });
  child.stderr?.on("data", bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, output };
  } finally { clearTimeout(timer); children.delete(child); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected fixture object");
  return Object.fromEntries(Object.entries(value));
}
function prepare(name: string, cwd: string) {
  const manifestPath = join(cwd, "package.json");
  const manifest = object(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (name === "pnpm-empty") {
    writeFileSync(manifestPath, JSON.stringify({ name: "empty-migration", version: "1.0.0" }));
    writeFileSync(join(cwd, "pnpm-lock.yaml"), Bun.YAML.stringify({ lockfileVersion: "9.0", settings: { autoInstallPeers: true, excludeLinksFromLockfile: false }, importers: { ".": {} } }));
  }
  if (name === "pnpm-snapshot-edges" || name === "pnpm-multiple-contexts") {
    const original = object(Bun.YAML.parse(readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8")));
    const integrity = object(object(object(original.packages)["no-deps@1.0.1"]).resolution).integrity;
    assert.equal(typeof integrity, "string");
    const multiple = name === "pnpm-multiple-contexts";
    const dependencies: Record<string, string> = { first: "npm:parent@1.0.0" };
    const imported: Record<string, unknown> = { first: { specifier: dependencies.first, version: "parent@1.0.0(peer@2.0.0)" } };
    if (multiple) { dependencies.second = "npm:parent@1.0.0"; imported.second = { specifier: dependencies.second, version: "parent@1.0.0(peer@3.0.0)" }; }
    writeFileSync(manifestPath, JSON.stringify({ name: "snapshot-reference-regression", version: "1.0.0", dependencies }));
    const packages: Record<string, unknown> = { "parent@1.0.0": { resolution: { integrity }, peerDependencies: { peer: "*" } }, "child@1.0.0": { resolution: { integrity } }, "peer@2.0.0": { resolution: { integrity } } };
    const snapshots: Record<string, unknown> = { "parent@1.0.0(peer@2.0.0)": { dependencies: { child: "1.0.0", peer: "2.0.0" } }, "child@1.0.0": {}, "peer@2.0.0": {} };
    if (multiple) {
      packages["peer@3.0.0"] = { resolution: { integrity } };
      snapshots["parent@1.0.0(peer@3.0.0)"] = { dependencies: { child: "1.0.0", peer: "3.0.0" } }; snapshots["peer@3.0.0"] = {};
    }
    writeFileSync(join(cwd, "pnpm-lock.yaml"), Bun.YAML.stringify({ lockfileVersion: "9.0", settings: { autoInstallPeers: true }, importers: { ".": { dependencies: imported } }, packages, snapshots }));
  }
  if (name === "pnpm-scoped-alias") {
    const file = join(cwd, "pnpm-lock.yaml");
    const source = object(Bun.YAML.parse(readFileSync(file, "utf8")));
    const deps = object(manifest.dependencies); delete deps.tb; delete deps["one-dep"]; manifest.dependencies = deps;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const importers = object(source.importers), rootImporter = object(importers["."]), rootDeps = object(rootImporter.dependencies);
    delete rootDeps.tb; delete rootDeps["one-dep"]; rootImporter.dependencies = rootDeps; importers["."] = rootImporter; source.importers = importers;
    const packages = object(source.packages), snapshots = object(source.snapshots);
    delete packages["tb@file:tb-1.0.0.tgz"]; delete snapshots["tb@file:tb-1.0.0.tgz"];
    delete packages["one-dep@1.0.0"]; delete snapshots["one-dep@1.0.0"];
    source.packages = packages; source.snapshots = snapshots;
    writeFileSync(file, Bun.YAML.stringify(source));
  }
  if (name === "classic-sha1") {
    writeFileSync(join(cwd, "yarn.lock"), readFileSync(join(cwd, "yarn.lock"), "utf8").replace(/^  integrity .*\n/gm, ""));
  }
  if (name === "classic-workspace-only") {
    mkdirSync(join(cwd, "packages/member"), { recursive: true });
    writeFileSync(join(cwd, "packages/member/package.json"), JSON.stringify({ name: "member", version: "1.0.0", dependencies: manifest.dependencies }));
    writeFileSync(manifestPath, JSON.stringify({ name: "root", version: "1.0.0", workspaces: ["packages/*"] }));
  }
  if (name === "pnpm-workspace-only") {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) delete manifest[field];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const file = join(cwd, "pnpm-lock.yaml");
    const source = object(Bun.YAML.parse(readFileSync(file, "utf8")));
    const importers = object(source.importers); importers["."] = {}; source.importers = importers;
    const packages = object(source.packages); delete packages["peer-deps-fixed@1.0.0"]; source.packages = packages;
    const snapshots = object(source.snapshots); delete snapshots["peer-deps-fixed@1.0.0(no-deps@1.0.1)"]; source.snapshots = snapshots;
    writeFileSync(file, Bun.YAML.stringify(source));
  }
  if (name === "git" || name === "http-tarball") {
    const key = name === "git" ? "full-git-url" : "remote";
    const dependencies = object(manifest.dependencies);
    writeFileSync(manifestPath, JSON.stringify({ name: "source-protocol", version: "1.0.0", dependencies: { [key]: dependencies[key] } }));
    const text = readFileSync(join(cwd, "yarn.lock"), "utf8");
    const stanza = text.split(/\n(?=[^ \n#])/).find(block => block.startsWith(`"${key}@`));
    assert.ok(stanza);
    writeFileSync(join(cwd, "yarn.lock"), `# yarn lockfile v1\n\n${stanza}\n`);
  }
}
const cases: readonly (readonly [string, string])[] = [
  ["npm", "npm-arborist/dep-installed-without-bin-link"],
  ["classic", "yarn/yarn-lock-mkdirp"],
  ["classic-sha1", "yarn/yarn-lock-mkdirp"],
  ["classic-workspace-only", "yarn/yarn-lock-mkdirp"],
  ["git", "yarn/yarn-stuff"],
  ["http-tarball", "yarn/yarn-stuff"],
  ["pnpm", "pnpm/basic"],
  ["pnpm-empty", "pnpm/basic"],
  ["pnpm-alias", "pnpm/v9-alias-in-optional-dependencies"],
  ["pnpm-scoped-alias", "pnpm/v9-reference-shapes"],
  ["pnpm-peer-context", "pnpm/v9-peer-range-dedupe"],
  ["pnpm-snapshot-edges", "pnpm/basic"],
  ["pnpm-multiple-contexts", "pnpm/basic"],
  ["pnpm-workspace", "pnpm/v9-importer-peers"],
  ["pnpm-workspace-only", "pnpm/v9-importer-peers"],
  ["berry", "yarn-berry/basic"],
  ["berry-workspace", "yarn-berry/workspaces"],
];
function captureLock(name: string, label: string, directory: string) {
  if (evidence && existsSync(join(directory, "bun.lock"))) writeFileSync(join(evidence, `${name}-${label}.lock`), readFileSync(join(directory, "bun.lock")));
}

function registryPackage(name: string, base: string): Response | undefined {
  const directory = resolve(upstream, "../registry/packages");
  const file = resolve(directory, name, "package.json");
  if (!file.startsWith(directory + "/") || !existsSync(file)) return;
  const manifest = object(JSON.parse(readFileSync(file, "utf8")));
  const versions = object(manifest.versions);
  for (const [version, value] of Object.entries(versions)) {
    const row = object(value), dist = object(row.dist);
    if (typeof dist.tarball === "string") dist.tarball = base + new URL(dist.tarball).pathname;
    row.dist = dist; versions[version] = row;
  }
  manifest.versions = versions;
  return Response.json(manifest);
}

async function checkMigration(name: string, source: string) {
  const reference = join(scratch, `${name}-native`), guest = join(scratch, `${name}-guest`);
  cpSync(join(upstream, source), reference, { recursive: true });
  prepare(name, reference);
  cpSync(reference, guest, { recursive: true });
  const native = await run(reference, true, "pm", "migrate");
  const actual = process.env.MIGRATION_REFERENCE_ONLY ? { code: 0, output: "reference only" } : await run(guest, false, "pm", "migrate");
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${name}.log`), JSON.stringify({ native, actual }, null, 2));
    const locks: [string, string][] = [["native", reference], ["guest", guest]];
    for (const [label, directory] of locks) captureLock(name, label, directory);
  }
  assert.equal(native.code, 0, `native ${name}: ${native.output}`);
  if (process.env.MIGRATION_REFERENCE_ONLY) { console.log(`PASS ${name}: native reference`); return; }
  if (name === "git" || name === "http-tarball") {
    assert.notEqual(actual.code, 0, actual.output);
    assert.match(actual.output, /Unsupported migrated resolution/);
    assert.equal(existsSync(join(guest, "bun.lock")), false);
    console.log(`PASS ${name}: rejected without publishing a lock`);
    return;
  }
  assert.equal(actual.code, 0, `guest ${name}: ${actual.output}`);
  const actualText = readFileSync(join(guest, "bun.lock"), "utf8");
  const nativeExpected = readFileSync(join(reference, "bun.lock"), "utf8");
  const expected = name === "classic-sha1"
    ? nativeExpected.replace('"lockfileVersion": 1', '"lockfileVersion": 2').replace(/, ""\],/g, ', "sha1-PrXtYmInVteaXw4qIh3+utdcL34="],')
    : name === "classic-workspace-only" && !nativeExpected.includes("packages/member") ? undefined : nativeExpected;
  if (name === "classic-workspace-only") {
    assert.match(actualText, /member@workspace:packages\/member/);
    assert.match(actualText, /mkdirp@1\.0\.4/);
  }
  if (expected !== undefined) assert.equal(actualText, expected, `${name} differs from native Bun`);
  rmSync(join(guest, "bun.lock"));
  const automatic = await run(guest, false, "install", "--frozen-lockfile", "--lockfile-only");
  assert.equal(automatic.code, 0, `${name} unchanged frozen foreign install: ${automatic.output}`);
  assert.equal(readFileSync(join(guest, "bun.lock"), "utf8"), actualText);
  const frozen = await run(guest, false, "install", "--frozen-lockfile", "--lockfile-only");
  assert.equal(frozen.code, 0, `${name} frozen reinstall: ${frozen.output}`);
  assert.equal(readFileSync(join(guest, "bun.lock"), "utf8"), actualText);
  if (name !== "pnpm-empty") {
    writeFileSync(join(reference, "bun.lock"), actualText);
    const nativeFrozen = await run(reference, true, "install", "--frozen-lockfile", "--lockfile-only");
    assert.equal(nativeFrozen.code, 0, `${name} native accepts converted lock: ${nativeFrozen.output}`);
    assert.equal(readFileSync(join(reference, "bun.lock"), "utf8"), actualText, `${name} native rewrote converted lock`);
  }
  if (name === "classic-sha1") {
    const cache = process.env.MATRIX_CACHE || "/work/cache/bun-wasm-app-matrix";
    const index = object(JSON.parse(readFileSync(join(cache, "index.json"), "utf8")));
    const archive = Object.entries(index).find(([path]) => path.endsWith(".tgz"));
    assert.ok(archive);
    const digest = object(archive[1]).sha256;
    assert.ok(typeof digest === "string");
    const bytes = readFileSync(join(cache, "objects", digest));
    const corrupt = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes) });
    registryOverride = String(corrupt.url).replace(/\/$/, "");
    try {
      const mismatch = await run(guest, false, "install", "--frozen-lockfile");
      assert.notEqual(mismatch.code, 0, mismatch.output);
      assert.match(mismatch.output, /integrity/i);
    } finally { registryOverride = undefined; await corrupt.stop(true); }
    console.log(`PASS ${name}: intentional checksum fix versus Bun 1.4.2; corrupt recorded archive rejected`);
  } else if (name === "classic-workspace-only") console.log(`PASS ${name}: workspace pins retained; native frozen format accepted; native pm migrate drops members`);
  else console.log(`PASS ${name}: native bytes and frozen reinstall`);
}


try {
  const recorded = await replay({ directory: process.env.MATRIX_CACHE || "/work/cache/bun-wasm-app-matrix", record: false });
  const metadata = object(JSON.parse(readFileSync(join(upstream, "yarn/npm-metadata.json"), "utf8")));
  const metadataRequests: string[] = [];
  let overlayBase = "";
  const overlay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const name = decodeURIComponent(path.slice(1));
    const packageRecord = registryPackage(name, overlayBase);
    if (packageRecord) { metadataRequests.push(name); return packageRecord; }
    if (!Object.hasOwn(metadata, name)) return fetch(`${recorded.base}${path}`);
    metadataRequests.push(name);
    const versions = Object.fromEntries(Object.entries(object(metadata[name])).map(([version, fields]) => [version, { name, version, ...object(fields) }]));
    return Response.json({ name, versions });
  } });
  overlayBase = String(overlay.url).replace(/\/$/, "");
  mirror = { ...recorded, base: overlayBase, async close() { await overlay.stop(true); await recorded.close(); } };
  for (const [name, source] of cases) {
    if (process.env.MIGRATION_CASES && !process.env.MIGRATION_CASES.split(",").includes(name)) continue;
    try { await checkMigration(name, source); } catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ recordedRegistry: mirror.snapshot(), metadataRequests }));
} finally { await cleanup(); }
