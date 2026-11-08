import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

import { fixture } from "./install-download-fixture";

async function install(directory: string, base: string, args: string[] = [], expected = 0, archives = false) {
  const engine = process.env.INSTALL_ENGINE ?? "quickjs";
  const wasm = resolve(process.env.BUN_WASM ?? join(root, "dist", engine === "quickjs" ? "bun.wasm" : `bun-${engine}.wasm`));
  const guest = ["--wasm", wasm, "--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${base}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--", "install"].concat(archives ? [] : ["--lockfile-only"], args);
  const launcher = process.env.BUN_WASM_LAUNCHER ?? join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "release/bun-wasm");
  const child = spawn(engine === "browser" ? "node" : launcher, engine === "browser" ? ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(guest) : guest, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    assert.equal(code, expected, output);
    return output;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function project(directory: string, dependencies: Record<string, string>) {
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", dependencies }));
}

for (const transitive of [false, true]) {
  test(`metadata requests overlap without changing ${transitive ? "transitive" : "root"} resolution`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-metadata-"));
    const registry = await fixture();
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", dependencies: transitive ? { parent: "1.0.0" } : registry.dependencies }));
      const start = performance.now();
      await install(directory, registry.base);
      console.log(`${process.env.INSTALL_ENGINE ?? "quickjs"} ${transitive ? "transitive" : "root"}: ${(performance.now() - start).toFixed(1)} ms, peak ${registry.trace.peak}`);
      assert.equal(registry.trace.missedBarrier, false, "second metadata request did not start before first response was released");
      assert.ok(registry.trace.peak > 1, "fixture observed only serial HTTP work");
      assert.ok(registry.trace.peak <= 8, `unbounded metadata requests: ${registry.trace.peak}`);
      assert.equal(registry.trace.requests.length, transitive ? 21 : 20);
      const lock = readFileSync(join(directory, "bun.lock"), "utf8");
      rmSync(join(directory, "cache"), { recursive: true, force: true });
      const before = registry.trace.requests.length;
      await install(directory, registry.base, ["--frozen-lockfile"]);
      assert.equal(registry.trace.requests.length, before, "locked install fetched metadata");
      assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), lock);
      assert.equal(registry.trace.active.size, 0);
    } finally {
      await registry.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);
}

test("metadata errors close other outstanding requests and local edges do not fetch", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-metadata-errors-"));
  const registry = await fixture();
  try {
    const directory = join(scratch, "failure");
    project(directory, { "a-fail": "1.0.0", "b-stall": "1.0.0" });
    assert.match(await install(directory, registry.base, [], 1), /503/);
    const deadline = performance.now() + 2000;
    while (registry.trace.active.size && performance.now() < deadline) await new Promise(accept => setTimeout(accept, 10));
    assert.equal(registry.trace.active.size, 0, "failed resolution left HTTP requests open");
    const local = join(scratch, "local");
    project(local, { child: "file:child" });
    project(join(local, "child"), {});
    const before = registry.trace.requests.length;
    await install(local, registry.base);
    assert.equal(registry.trace.requests.length, before, "local install fetched metadata");
  } finally {
    await registry.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60000);


test("tarball downloads overlap and warm installs request nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-archives-"));
  const registry = await fixture("tarball");
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", dependencies: registry.dependencies }));
    const start = performance.now();
    await install(directory, registry.base, [], 0, true);
    console.log(`${process.env.INSTALL_ENGINE ?? "quickjs"} archives: ${(performance.now() - start).toFixed(1)} ms, peak ${registry.trace.peak}`);
    assert.equal(registry.trace.missedBarrier, false, "second tarball request did not start before first archive was released");
    assert.ok(registry.trace.peak > 1 && registry.trace.peak <= 8, `tarball concurrency ${registry.trace.peak}`);
    for (const name of Object.keys(registry.dependencies)) {
      assert.equal(JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")).name, name);
    }
    const before = registry.trace.requests.length;
    await install(directory, registry.base, ["--frozen-lockfile"], 0, true);
    assert.equal(registry.trace.requests.length, before, "no-op install requested metadata or archives");
  } finally {
    await registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
