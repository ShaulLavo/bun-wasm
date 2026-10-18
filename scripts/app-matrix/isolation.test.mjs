import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { sha256 } from "./registry.mjs";

const root = resolve(import.meta.dir, "../..");
function launch(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });
}

async function createSentinel(hostname) {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.end(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, hostname, resolve); });
  return { port: server.address().port, count: () => connections, close: () => new Promise(resolve => server.close(resolve)) };
}

function fixture() {
  const directory = mkdtempSync("/work/tmp/bun-wasm-app-matrix-review-test-");
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    cpSync(join(root, "scripts/app-matrix"), join(directory, "scripts/app-matrix"), { recursive: true });
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist/bun.wasm"), "fixture");
    mkdirSync(join(directory, "web/dist"), { recursive: true });
    mkdirSync(join(directory, "web/tests"), { recursive: true });
    cpSync(join(root, "web/tests/playground.mjs"), join(directory, "web/tests/playground.mjs"), { recursive: true });
    cpSync(join(root, "web/tests/foreground.ts"), join(directory, "web/tests/foreground.ts"));
    mkdirSync(join(directory, "owned-scratch"));
    // The runner records its own checkout revision before executing any stages.
    for (const args of [
      ["init", "--quiet", directory],
      ["-C", directory, "-c", "user.name=Matrix fixture", "-c", "user.email=matrix@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Create isolated matrix fixture"],
    ]) {
      const git = spawnSync("git", args, { encoding: "utf8" });
      if (git.status !== 0) throw new Error(`Cannot prepare matrix fixture revision: ${git.stderr}`);
    }
    return { directory, cleanup };
  } catch (error) { cleanup(); throw error; }
}

async function matrix(directory, extra = [], prefix = []) {
  return launch(prefix.concat([join(directory, "scripts/app-matrix/isolate.mjs"), "--apps=typescript,eslint", "--engines=quickjs", "--hosts=native", "--launcher=/usr/bin/true", `--cache=${directory}/cache`, `--output=${directory}/results`], extra), { MATRIX_SCRATCH_ROOT: join(directory, "owned-scratch"), PLAYWRIGHT: join(root, "web/node_modules/playwright/index.mjs") });
}

test("native server must stay alive until its DOM assertion completes", async () => {
  const { directory, cleanup } = fixture();
  try {
    const html = '<html><body>loading<script>setTimeout(() => document.body.textContent = "matrix", 250)</script></body></html>';
    const server = exit => `let requests = 0; Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT), fetch() { if (++requests >= 2 && ${exit}) setTimeout(() => process.exit(0), 10); return new Response(${JSON.stringify(html)}, { headers: { 'content-type': 'text/html' } }); } });`;
    const app = {
      id: "native-dom", dependencies: {}, files: { "live.js": server(false), "exit.js": server(true) },
      commands: ["live", "exit"].map(name => ({ name, args: ["run", `${name}.js`], check: { kind: "page", selector: "body", text: "matrix" } })),
    };
    writeFileSync(join(directory, "scripts/app-matrix/apps.mjs"), `export { projectFiles } from ${JSON.stringify(join(root, "scripts/app-matrix/apps.mjs"))}; export const apps = ${JSON.stringify([app])}; export const browserSubset = [];`);
    const result = await matrix(directory, ["--apps=native-dom", "--reference", "--timeout=10"]);
    expect(result.code, result.output).toBe(0);
    const { results } = JSON.parse(readFileSync(join(directory, "results/results.json")));
    const reference = results.filter(row => row.engine === "reference");
    expect(reference.find(row => row.stage === "install").status).toBe("pass");
    expect(reference.find(row => row.stage === "live").status).toBe("pass");
    expect(reference.find(row => row.stage === "exit")).toMatchObject({ status: "fail", exit: 0 });
    expect(reference.find(row => row.stage === "exit").blocker).toContain("before HTTP/DOM assertion");
    expect(readdirSync(join(directory, "owned-scratch"))).toEqual([]);
  } finally { cleanup(); }
}, 30000);

test("broker transport failure exits nonzero, records infrastructure error, and caches nothing", async () => {
  const { directory, cleanup } = fixture();
  try {
    const preload = join(directory, "outage-preload.mjs");
    writeFileSync(preload, `const original = globalThis.fetch; globalThis.fetch = (input, options) => { if (String(input).startsWith('https://registry.npmjs.org/')) throw new Error('injected broker transport failure'); return original(input, options); };`);
    const result = await matrix(directory, ["--apps=hono", "--record", "--timeout=2"], ["--preload", preload]);
    expect(result.code).toBe(1);
    const report = JSON.parse(readFileSync(join(directory, "results/results.json")));
    expect(report.provenance.registry.errors.join("\n")).toContain("injected broker transport failure");
    expect(report.provenance.registry.errors.join("\n")).toContain("/hono");
    expect(report.provenance.registry.misses).toEqual([]);
    const index = join(directory, "cache/index.json");
    expect(existsSync(index) ? JSON.parse(readFileSync(index)) : {}).not.toHaveProperty("/hono");
    expect(readdirSync(join(directory, "cache/objects"))).toEqual([]);
    expect(existsSync(join(directory, "cache/record.lock"))).toBe(false);
    expect(readdirSync(join(directory, "owned-scratch"))).toEqual([]);
  } finally { cleanup(); }
}, 30000);

function corruptManifest(directory, fault) {
  if (fault === "malformed-manifest") writeFileSync(join(directory, "web/dist/engine-builds.json"), "{bad");
}

test("setup failures remove scratch after launcher copy and malformed manifest", async () => {
  for (const fault of ["launcher-directory", "malformed-manifest"]) {
    const { directory, cleanup } = fixture();
    try {
      const args = fault === "launcher-directory" ? [`--launcher=${directory}`] : [];
      corruptManifest(directory, fault);
      const result = await matrix(directory, args);
      expect(result.code).toBe(1);
      expect(result.output).toContain('"cleanup":true');
      expect(readdirSync(join(directory, "owned-scratch"))).toEqual([]);
    } finally { cleanup(); }
  }
}, 30000);

test("real no-op launcher cannot pass install or tooling stages", async () => {
  const { directory, cleanup } = fixture();
  try {
    const result = await matrix(directory);
    expect(result.code, result.output).toBe(0);
    const { results } = JSON.parse(readFileSync(join(directory, "results/results.json")));
    expect(results.length).toBe(6);
    expect(results.filter(row => row.status === "pass")).toEqual([]);
    expect(results.filter(row => row.stage === "install").map(row => row.status)).toEqual(["fail", "fail"]);
    expect(readdirSync(join(directory, "owned-scratch"))).toEqual([]);
  } finally { cleanup(); }
}, 30000);

test("external-origin tarball is an infrastructure error with zero sentinel connections", async () => {
  const { directory, cleanup } = fixture();
  let sentinel;
  try {
    sentinel = await createSentinel("127.0.0.1");
    const cache = join(directory, "cache");
    mkdirSync(join(cache, "objects"), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ name: "hono", versions: { "4.10.2": { name: "hono", version: "4.10.2", dist: { tarball: `http://127.0.0.1:${sentinel.port}/external.tgz` } } } }));
    const digest = sha256(bytes);
    writeFileSync(join(cache, "objects", digest), bytes);
    writeFileSync(join(cache, "index.json"), JSON.stringify({ "/hono": { status: 200, type: "application/json", sha256: digest } }));
    const result = await matrix(directory, ["--apps=hono", "--reference", "--timeout=2"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(readFileSync(join(directory, "results/results.json")));
    expect(report.provenance.registry.errors.join("\n")).toContain("Unsupported tarball origin");
    expect(sentinel.count()).toBe(0);
    expect(readdirSync(join(directory, "owned-scratch"))).toEqual([]);
  } finally { await sentinel?.close(); cleanup(); }
}, 30000);

test("namespace blocks host network for the complete descendant tree, while local HTTP works", async () => {
  const { directory, cleanup } = fixture();
  let sentinel;
  try {
    sentinel = await createSentinel("0.0.0.0");
    const { networkInterfaces } = await import("node:os");
    const address = Object.values(networkInterfaces()).flat().find(item => item.family === "IPv4" && !item.internal).address;
    const script = join(directory, "network-probe.mjs");
    writeFileSync(script, `
      import { spawnSync } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      const devices = readFileSync('/proc/net/dev', 'utf8');
      if (/eth|wlan|enp|tailscale/.test(devices)) process.exit(2);
      const local = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('local') });
      if (await (await fetch('http://127.0.0.1:' + local.port)).text() !== 'local') process.exit(3);
      const probe = "fetch('http://${address}:${sentinel.port}', {signal:AbortSignal.timeout(500)}).then(()=>process.exit(4),()=>process.exit(0))";
      const child = spawnSync(process.execPath, ['-e', probe]);
      await local.stop(true);
      process.exit(child.status);
    `);
    const result = await new Promise((resolve, reject) => {
      const child = spawn("unshare", ["-Urn", "sh", "-ec", 'ip link set lo up; exec "$@"', "probe", process.execPath, script], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(result).toBe(0);
    expect(sentinel.count()).toBe(0);
  } finally { await sentinel?.close(); cleanup(); }
}, 30000);
