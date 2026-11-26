import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixture, installFixtureCommand, installFixtureTargets, type InstallFixtureTarget } from "./install-fixture-command";
import { packageFixture } from "../tests/install/registry.mjs";

// An install that starts without node_modules prepares packages while resolution waits on
// metadata. These cases hold `b-delayed`'s metadata so that work happens, and compare with a
// control run whose empty node_modules turns it off.
const STAGING = ".bun-wasm-early";

interface Registry { base: string; requests: string[]; close(): Promise<void> }
interface Options { delayed: 200 | 404 | "hold"; firstArchive?: 200 | 503 }

async function registry(options: Options): Promise<Registry> {
  const packages = new Map(["a-known", "b-delayed", "c-other"].map(name => [name, packageFixture(name, "1.0.0")]));
  const requests: string[] = [];
  const held: ServerResponse[] = [];
  let base = "";
  let failed = false;
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").slice(1));
    requests.push(path);
    const archive = path.startsWith("archives/");
    const name = archive ? path.slice("archives/".length) : path;
    const fixture = packages.get(name);
    if (!fixture) { response.writeHead(404).end(); return; }
    if (archive) {
      if (name === "a-known" && options.firstArchive === 503 && !failed) { failed = true; response.writeHead(503).end(); return; }
      response.end(fixture.archive);
      return;
    }
    const metadata = () => {
      if (name === "b-delayed" && options.delayed === 404) { response.writeHead(404).end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { ...fixture.manifest, dist: { tarball: `${base}/archives/${name}`, integrity: fixture.integrity } } } }));
    };
    if (name !== "b-delayed") { metadata(); return; }
    if (options.delayed === "hold") { held.push(response); return; }
    setTimeout(metadata, 1500);
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    requests,
    async close() {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>(accept => server.close(() => accept()));
    },
  };
}

function project(manifest: object, control = false): string {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-early-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  if (control) mkdirSync(join(directory, "node_modules"));
  return directory;
}

const archiveRequests = (registry: Registry) => registry.requests.filter(path => path === "archives/a-known").length;

async function withRegistry(options: Options, run: (registry: Registry) => Promise<void>) {
  const server = await registry(options);
  try { await run(server); } finally { await server.close(); }
}

for (const target of installFixtureTargets()) {
  const install = (directory: string, base: string, expected: number) => installFixture(directory, base, [], expected, true, [], target);

  test(`${target.engine}: a metadata error after early work leaves no packages behind`, () => withRegistry({ delayed: 404 }, async server => {
    const directory = project({ dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } });
    try {
      await install(directory, server.base, 1);
      assert.equal(archiveRequests(server), 1, "the archive was not requested while resolution waited");
      for (const path of ["node_modules", STAGING, "bun.lock"]) assert.ok(!existsSync(join(directory, path)), `${path} exists`);
      // A later install of a different graph never sees what was prepared.
      writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: {} }));
      await install(directory, server.base, 0);
      assert.ok(!existsSync(join(directory, "node_modules/a-known")));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }), 120_000);

  test(`${target.engine}: a killed install's staging never reaches a different graph`, () => withRegistry({ delayed: "hold" }, async server => {
    const directory = project({ dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } });
    try {
      await killWhenStaged(directory, server.base, target);
      assert.ok(!existsSync(join(directory, "node_modules")), "early work wrote into node_modules");
      writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { "c-other": "1.0.0" } }));
      await install(directory, server.base, 0);
      assert.ok(existsSync(join(directory, "node_modules/c-other/package.json")));
      assert.ok(!existsSync(join(directory, "node_modules/a-known")), "a package from the killed run was published");
      assert.ok(!existsSync(join(directory, STAGING)));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }), 120_000);

  test(`${target.engine}: an optional file dependency resolves the same with early work`, () => withRegistry({ delayed: 200 }, async server => {
    const manifest = { dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" }, optionalDependencies: { "z-local": "file:./node_modules/a-known" } };
    const early = project(manifest);
    const control = project(manifest, true);
    try {
      await install(early, server.base, 0);
      await install(control, server.base, 0);
      assert.equal(readFileSync(join(early, "bun.lock"), "utf8"), readFileSync(join(control, "bun.lock"), "utf8"));
    } finally {
      rmSync(early, { recursive: true, force: true });
      rmSync(control, { recursive: true, force: true });
    }
  }), 120_000);

  for (const optional of [false, true]) {
    const kind = optional ? "optional" : "required";
    test(`${target.engine}: a transient archive failure of a ${kind} dependency ends the same with early work`, async () => {
      const manifest = optional
        ? { dependencies: { "b-delayed": "1.0.0" }, optionalDependencies: { "a-known": "1.0.0" } }
        : { dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } };
      const results: { output: string; requests: number; installed: boolean }[] = [];
      for (const control of [false, true]) {
        await withRegistry({ delayed: 200, firstArchive: 503 }, async server => {
          const directory = project(manifest, control);
          try {
            const output = await install(directory, server.base, optional ? 0 : 1);
            results.push({ output, requests: archiveRequests(server), installed: existsSync(join(directory, "node_modules/a-known")) });
          } finally { rmSync(directory, { recursive: true, force: true }); }
        });
      }
      const [early, control] = results;
      assert.equal(early!.requests, 1, "the failed archive was fetched again");
      assert.deepEqual([early!.requests, early!.installed], [control!.requests, control!.installed]);
      assert.match(early!.output, /503/);
    }, 120_000);
  }
}

/** Starts an install, kills it once a package is staged, and waits for it to exit. */
async function killWhenStaged(directory: string, base: string, target: InstallFixtureTarget) {
  const [program, argv] = installFixtureCommand(directory, base, [], true, [], target);
  const child = spawn(program, argv, { cwd: directory, stdio: "ignore" });
  const exited = new Promise<void>(accept => child.once("close", () => accept()));
  try {
    const staging = join(directory, STAGING);
    const deadline = Date.now() + 60_000;
    const staged = () => existsSync(staging) && readdirSync(staging).some(job => existsSync(join(staging, job, "package.json")));
    while (!staged()) {
      assert.ok(Date.now() < deadline, "no package was staged");
      await new Promise(accept => setTimeout(accept, 20));
    }
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}
