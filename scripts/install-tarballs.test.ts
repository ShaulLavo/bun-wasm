import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixture, installFixtureTargets, type InstallFixtureTarget } from "./install-fixture-command";
import { packageFixture } from "../tests/install/registry.mjs";

function install(target: InstallFixtureTarget, directory: string, registry: string, args: string[] = [], expected = 0) {
  return installFixture(directory, registry, args, expected, true, [], target);
}

function lockedToolSource(directory: string): string {
  const lock = Bun.JSONC.parse(readFileSync(join(directory, "bun.lock"), "utf8"));
  assert.ok(lock && typeof lock === "object" && "packages" in lock);
  assert.ok(lock.packages && typeof lock.packages === "object" && "tool" in lock.packages);
  assert.ok(Array.isArray(lock.packages.tool));
  assert.equal(typeof lock.packages.tool[1], "string");
  return lock.packages.tool[1];
}

async function remoteOverrides(target: InstallFixtureTarget) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-tarball-"));
  const selected = packageFixture("@fixture/leaf", "1.2.3-custom.1", { dependencies: { child: "1.0.0" } });
  const child = packageFixture("child", "1.0.0");
  const outer = packageFixture("outer", "1.0.0", { optionalDependencies: { "@fixture/leaf": "^0.1" } });
  const requests: string[] = [];
  let base = "";
  let archive = selected.archive;
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    response.setHeader("access-control-allow-origin", "*");
    if (path === "/opaque") { response.end(archive); return; }
    if (path === "/archives/child") { response.end(child.archive); return; }
    if (path === "/archives/outer") { response.end(outer.archive); return; }
    const fixture = path === "/child" ? child : path === "/outer" ? outer : undefined;
    if (!fixture) { response.writeHead(503).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ versions: { "1.0.0": { ...fixture.manifest, dist: { tarball: `${base}/archives${path}`, integrity: fixture.integrity } } } }));
  });
  try {
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
    const source = `${base}/opaque`;
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { outer: "1.0.0" }, overrides: { "@fixture/leaf": source } }));
    await install(target, directory, base);
    const text = readFileSync(join(directory, "bun.lock"), "utf8");
    const lock = Bun.JSONC.parse(text);
    assert.ok(lock && typeof lock === "object" && "packages" in lock);
    assert.ok(lock.packages && typeof lock.packages === "object" && "@fixture/leaf" in lock.packages);
    assert.deepEqual(lock.packages["@fixture/leaf"], ["@fixture/leaf@1.2.3-custom.1", source, { dependencies: { child: "1.0.0" } }, selected.integrity]);
    assert.equal(JSON.parse(readFileSync(join(directory, "node_modules/child/package.json"), "utf8")).name, "child");
    assert.ok(!requests.some(path => path.startsWith("/@fixture")), "URL override requested registry metadata");
    const count = requests.length;
    rmSync(join(directory, "node_modules"), { recursive: true });
    await install(target, directory, base, ["--frozen-lockfile"]);
    assert.equal(requests.length, count, "warm URL cache was not reused");
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), text);
    archive = packageFixture("@fixture/leaf", "1.2.3-custom.1", { tampered: true }).archive;
    const failed = await install(target, directory, base, ["--frozen-lockfile", "--force"], 1);
    assert.match(failed, /Integrity check failed/);
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), text);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    rmSync(directory, { recursive: true, force: true });
  }
}

async function restoreRegistrySource(target: InstallFixtureTarget) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-review-restore-"));
  const direct = packageFixture("tool", "1.2.3", { source: "direct" });
  const registry = packageFixture("tool", "1.2.3", { source: "registry" });
  let base = "";
  const server = createServer((request, response) => {
    if (request.url === "/direct") { response.end(direct.archive); return; }
    if (request.url === "/registry.tgz") { response.end(registry.archive); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ versions: { "1.2.3": { ...registry.manifest, dist: { tarball: `${base}/registry.tgz`, integrity: registry.integrity } } } }));
  });
  try {
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { tool: `${base}/direct` } }));
    await install(target, directory, base);
    assert.equal(JSON.parse(readFileSync(join(directory, "node_modules/tool/package.json"), "utf8")).source, "direct");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { tool: "^1" } }));
    await install(target, directory, base);
    assert.equal(lockedToolSource(directory), `${base}/registry.tgz`);
    assert.equal(JSON.parse(readFileSync(join(directory, "node_modules/tool/package.json"), "utf8")).source, "registry");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    rmSync(directory, { recursive: true, force: true });
  }
}


async function installLockfileOnlySource(target: InstallFixtureTarget) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-review-lockonly-"));
  const first = packageFixture("tool", "1.2.3", { source: "first" });
  const second = packageFixture("tool", "1.2.3", { source: "second" });
  const server = createServer((request, response) => {
    response.end(request.url === "/first" ? first.archive : second.archive);
  });
  try {
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { tool: `${base}/first` } }));
    await install(target, directory, base);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { tool: `${base}/second` } }));
    await install(target, directory, base, ["--lockfile-only"]);
    assert.equal(lockedToolSource(directory), `${base}/second`);
    assert.equal(JSON.parse(readFileSync(join(directory, "node_modules/tool/package.json"), "utf8")).source, "first", "lockfile-only changed installed files");
    await install(target, directory, base, ["--frozen-lockfile"]);
    assert.equal(JSON.parse(readFileSync(join(directory, "node_modules/tool/package.json"), "utf8")).source, "second");
    writeFileSync(join(directory, "node_modules/tool/retained"), "same source");
    await install(target, directory, base, ["--frozen-lockfile"]);
    assert.equal(readFileSync(join(directory, "node_modules/tool/retained"), "utf8"), "same source", "unchanged source was unnecessarily replaced");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const target of installFixtureTargets()) {
  test(`remote tarball overrides install manifest dependencies and retain locked integrity (${target.engine})`, () => remoteOverrides(target), 120000);
  test(`switching URL to registry installs registry files at the same version (${target.engine})`, () => restoreRegistrySource(target), 120000);
  test(`lockfile-only URL changes cannot mark old installed files current (${target.engine})`, () => installLockfileOnlySource(target), 120000);
}
