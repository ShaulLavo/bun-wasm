import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixture } from "./install-fixture-command";
import { packageFixture } from "../tests/install/registry.mjs";

function install(directory: string, registry: string, args: string[] = [], expected = 0) {
  return installFixture(directory, registry, args, expected, true);
}

test("remote tarball overrides install manifest dependencies and retain locked integrity", async () => {
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
    await install(directory, base);
    const text = readFileSync(join(directory, "bun.lock"), "utf8");
    const lock = Bun.JSONC.parse(text);
    assert.ok(lock && typeof lock === "object" && "packages" in lock);
    assert.ok(lock.packages && typeof lock.packages === "object" && "@fixture/leaf" in lock.packages);
    assert.deepEqual(lock.packages["@fixture/leaf"], ["@fixture/leaf@1.2.3-custom.1", source, { dependencies: { child: "1.0.0" } }, selected.integrity]);
    assert.equal(JSON.parse(readFileSync(join(directory, "node_modules/child/package.json"), "utf8")).name, "child");
    assert.ok(!requests.some(path => path.startsWith("/@fixture")), "URL override requested registry metadata");
    const count = requests.length;
    rmSync(join(directory, "node_modules"), { recursive: true });
    await install(directory, base, ["--frozen-lockfile"]);
    assert.equal(requests.length, count, "warm URL cache was not reused");
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), text);
    archive = packageFixture("@fixture/leaf", "1.2.3-custom.1", { tampered: true }).archive;
    const failed = await install(directory, base, ["--frozen-lockfile", "--force"], 1);
    assert.match(failed, /Integrity check failed/);
    assert.equal(readFileSync(join(directory, "bun.lock"), "utf8"), text);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 120000);
