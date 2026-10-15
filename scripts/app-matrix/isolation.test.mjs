import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
    mkdirSync(join(directory, "owned-scratch"));
    return { directory, cleanup };
  } catch (error) { cleanup(); throw error; }
}

async function matrix(directory, extra = []) {
  return launch([join(directory, "scripts/app-matrix/isolate.mjs"), "--apps=typescript,eslint", "--engines=quickjs", "--hosts=native", "--launcher=/usr/bin/true", `--cache=${directory}/cache`, `--output=${directory}/results`].concat(extra), { MATRIX_SCRATCH_ROOT: join(directory, "owned-scratch") });
}

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
    expect(result.code).toBe(0);
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
