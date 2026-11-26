import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixture, installFixtureCommand, installFixtureTargets, type InstallFixtureTarget } from "./install-fixture-command";
import { packageFixture, tarEntry } from "../tests/install/registry.mjs";

// An install that starts without node_modules prepares packages while resolution waits on
// metadata. These cases hold `b-delayed`'s metadata so that work happens, and compare with a
// control run whose empty node_modules turns it off. The guest stages in its temporary
// directory, which these fixtures map to `<project>/tmp`.
const STAGING = "bun-wasm-early-";

type Fixture = ReturnType<typeof packageFixture>;
interface Registry { base: string; requests: string[]; close(): Promise<void> }
interface Options {
  /** How `b-delayed`'s metadata answers: after this many milliseconds, with a 404, or never. */
  delayed: number | 404 | "hold";
  /** Answers this archive's request number `failAt` (from 1) with a 503. */
  failArchive?: string;
  failAt?: number;
  packages?: Fixture[];
}

async function registry(options: Options): Promise<Registry> {
  const fixtures = ["a-known", "b-delayed", "c-other"].map(name => packageFixture(name, "1.0.0")).concat(options.packages ?? []);
  const packages = new Map(fixtures.map(fixture => [fixture.manifest.name, fixture]));
  const requests: string[] = [];
  const held: ServerResponse[] = [];
  let base = "";
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").slice(1));
    requests.push(path);
    const archive = path.startsWith("archives/");
    const name = archive ? path.slice("archives/".length) : path;
    const fixture = packages.get(name);
    if (!fixture) { response.writeHead(404).end(); return; }
    if (archive) {
      const failing = name === options.failArchive && requests.filter(seen => seen === path).length === (options.failAt ?? 1);
      if (failing) { response.writeHead(503).end(); return; }
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
    setTimeout(metadata, options.delayed === 404 ? 1500 : options.delayed);
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
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-early-test-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  if (control) mkdirSync(join(directory, "node_modules"));
  return directory;
}

const archiveRequests = (registry: Registry, name = "a-known") => registry.requests.filter(path => path === `archives/${name}`).length;

/** Staging directories in the guest's temporary directory. */
function stagings(directory: string): string[] {
  const temp = join(directory, "tmp");
  return existsSync(temp) ? readdirSync(temp).filter(name => name.startsWith(STAGING)).map(name => join(temp, name)) : [];
}

async function withRegistry(options: Options, run: (registry: Registry) => Promise<void>) {
  const server = await registry(options);
  try { await run(server); } finally { await server.close(); }
}

/** Runs `install` in an early project and in a control project of the same manifest. */
async function bothArms(manifest: object, prepare: (directory: string) => void, run: (directory: string) => Promise<void>) {
  for (const control of [false, true]) {
    const directory = project(manifest, control);
    try {
      prepare(directory);
      await run(directory);
      assert.deepEqual(stagings(directory), [], "staging was left behind");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

for (const target of installFixtureTargets()) {
  const install = (directory: string, base: string, expected: number, archives = true, environment: string[] = []) => installFixture(directory, base, [], expected, archives, environment, target);

  test(`${target.engine}: a metadata error after early work leaves no packages behind`, () => withRegistry({ delayed: 404 }, async server => {
    const directory = project({ dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } });
    try {
      await install(directory, server.base, 1);
      assert.equal(archiveRequests(server), 1, "the archive was not requested while resolution waited");
      for (const path of ["node_modules", "bun.lock"]) assert.ok(!existsSync(join(directory, path)), `${path} exists`);
      assert.deepEqual(stagings(directory), []);
      // A later install of a different graph never sees what was prepared.
      writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: {} }));
      await install(directory, server.base, 0);
      assert.ok(!existsSync(join(directory, "node_modules/a-known")));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }), 120_000);

  test(`${target.engine}: a killed install's staging is reaped and never reaches a different graph`, () => withRegistry({ delayed: "hold" }, async server => {
    const directory = project({ dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } });
    try {
      await killWhenStaged(directory, server.base, target);
      assert.ok(!existsSync(join(directory, "node_modules")), "early work wrote into node_modules");
      writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { "c-other": "1.0.0" } }));
      await install(directory, server.base, 0);
      assert.ok(existsSync(join(directory, "node_modules/c-other/package.json")));
      assert.ok(!existsSync(join(directory, "node_modules/a-known")), "a package from the killed run was published");
      assert.deepEqual(stagings(directory), [], "the killed run's staging was not reaped");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }), 120_000);

  test(`${target.engine}: a project's own .bun-wasm-early directory is never touched`, () => withRegistry({ delayed: 1500 }, async server => {
    const directory = project({ dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } });
    const owned = join(directory, ".bun-wasm-early/user-file");
    try {
      mkdirSync(join(directory, ".bun-wasm-early"));
      writeFileSync(owned, "mine");
      await install(directory, server.base, 0, false);
      assert.equal(readFileSync(owned, "utf8"), "mine", "a lockfile-only install touched the project");
      assert.equal(archiveRequests(server), 0, "a lockfile-only install fetched archives");
      rmSync(join(directory, "bun.lock"));
      await install(directory, server.base, 0);
      assert.equal(readFileSync(owned, "utf8"), "mine", "a cold install touched the project");
      assert.ok(existsSync(join(directory, "node_modules/a-known/package.json")));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }), 120_000);

  for (const local of ["./node_modules/a-known", "./.bun-wasm-early/1"]) {
    test(`${target.engine}: an optional file:${local} dependency resolves the same with early work`, () => withRegistry({ delayed: 1500 }, async server => {
      const manifest = { dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" }, optionalDependencies: { "z-local": `file:${local}` } };
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
  }

  for (const optional of [false, true]) {
    const kind = optional ? "optional" : "required";
    test(`${target.engine}: a transient archive failure of a ${kind} dependency ends the same with early work`, async () => {
      const manifest = optional
        ? { dependencies: { "b-delayed": "1.0.0" }, optionalDependencies: { "a-known": "1.0.0" } }
        : { dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } };
      const results: { output: string; requests: number; installed: boolean }[] = [];
      for (const control of [false, true]) {
        await withRegistry({ delayed: 1500, failArchive: "a-known" }, async server => {
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

  test(`${target.engine}: two aliases of one large archive share one fetch without a cache`, async () => {
    // Incompressible, so the archive itself is large; a second request would get a 503.
    const big = packageFixture("big", "1.0.0", {}, undefined, [tarEntry("package/blob", randomBytes(17 << 20))]);
    const manifest = { dependencies: { first: "npm:big@1.0.0", second: "npm:big@1.0.0", "b-delayed": "1.0.0" } };
    await bothArms(manifest, directory => writeFileSync(join(directory, "cache"), "not a directory"), directory => withRegistry({ delayed: 1500, failArchive: "big", failAt: 2, packages: [big] }, async server => {
      await install(directory, server.base, 0);
      assert.equal(archiveRequests(server, "big"), 1, "the shared archive was fetched again");
      for (const alias of ["first", "second"]) assert.ok(existsSync(join(directory, `node_modules/${alias}/blob`)), `${alias} is missing`);
    }));
  }, 240_000);

  test(`${target.engine}: a long early extraction never times out the response it waited on`, async () => {
    // One 240 MiB entry: extraction can't pause inside it and outlasts the 1 s idle timeout,
    // while the awaited metadata arrives after 650 ms.
    const long = packageFixture("a-known", "1.0.0", {}, undefined, [tarEntry("package/zeros", Buffer.alloc(240 << 20))]);
    const manifest = { dependencies: { "a-known": "1.0.0", "b-delayed": "1.0.0" } };
    await bothArms(manifest, () => {}, directory => withRegistry({ delayed: 650, packages: [long] }, async server => {
      await install(directory, server.base, 0, true, ["BUN_CONFIG_HTTP_IDLE_TIMEOUT=1"]);
      assert.ok(existsSync(join(directory, "node_modules/b-delayed/package.json")));
    }));
  }, 240_000);
}

/** Starts an install, kills it once a package is staged, and waits for it to exit. */
async function killWhenStaged(directory: string, base: string, target: InstallFixtureTarget) {
  const [program, argv] = installFixtureCommand(directory, base, [], true, [], target);
  const child = spawn(program, argv, { cwd: directory, stdio: "ignore" });
  const exited = new Promise<void>(accept => child.once("close", () => accept()));
  try {
    const deadline = Date.now() + 60_000;
    const staged = () => stagings(directory).some(staging => readdirSync(staging).some(job => existsSync(join(staging, job, "package.json"))));
    while (!staged()) {
      assert.ok(Date.now() < deadline, "no package was staged");
      await new Promise(accept => setTimeout(accept, 20));
    }
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}
