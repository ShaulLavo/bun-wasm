import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { buildBrowserEntries } from "./browser-build.ts";
import { programKind, programProfile } from "../src/engine-kind.ts";
import { loadBunWasm } from "../src/assets.ts";

const repository = resolve(import.meta.dir, "..");
const fixtures = join(repository, "tests/hermes/hosts");
const hostCases = [
  { path: "hello.cts", stdout: "hello Hermes 2\n" },
  { path: "module.mts", stdout: "Hermes module 42\n" },
] as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type HostCase = { readonly path: string; readonly stdout: string };
async function verifyHermesHosts(corePath: string, browsers: boolean, metadataOnly: boolean) {
  const cases: readonly HostCase[] = metadataOnly ? [{ path: "metadata.mts", stdout: "Hermes main true\n" }] : hostCases;
  const core = readFileSync(corePath);
  const sidePath = join(dirname(corePath), programProfile("hermes").side);
  const side = readFileSync(sidePath);
  const describe = (path: string, bytes: Uint8Array) => ({ path, bytes: bytes.length, sha256: sha256(bytes) });
  const identity = { core: describe(corePath, core), side: describe(sidePath, side) };
  const module = await loadBunWasm({ asset: { kind: "hermes",
    core: { url: "https://fixture.invalid/bun-hermes.wasm", bytes: core.length, sha256: sha256(core) },
    side: { url: "https://fixture.invalid/hermes-engine.wasm", bytes: side.length, sha256: sha256(side) } },
    fetch: async url => new Response(url.endsWith("hermes-engine.wasm") ? side : core),
  });
  assert.equal(programKind(module), "hermes");
  const native = await nativeSmoke(corePath, cases);
  const browser = browsers ? await browserSmoke(identity, cases, metadataOnly) : null;
  return { identity, packageHost: { runtime: "bun", version: Bun.version, engine: programKind(module) }, native, browser };
}

async function nativeSmoke(corePath: string, cases: readonly HostCase[]) {
  const scratch = await mkdtemp(join(tmpdir(), "bw-h5-node-"));
  const env = { ...process.env, BUN_WASM_SCRATCH_ROOT: scratch };
  try {
    const results = ["node", process.execPath].flatMap(executable => cases.map(test => runNativeCase(executable, test, corePath, env)));
    assert.deepEqual(readdirSync(scratch), [], "Node/Bun fixture hosts released their private executable mounts");
    return results;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    assert.equal(existsSync(scratch), false);
    console.log(JSON.stringify({ cleanup: { nativeExecutableRootsRemoved: true, scratchRemoved: true } }));
  }
}

function runNativeCase(executable: string, test: HostCase, corePath: string, env: NodeJS.ProcessEnv) {
  const actual = spawnSync(executable, ["--disable-warning=ExperimentalWarning", join(repository, "web/scripts/node-host.ts"),
    "--wasm", corePath, "--", "run", join(fixtures, test.path)], { encoding: "utf8", timeout: 60_000, env });
  assert.equal(actual.error, undefined);
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(actual.stdout, test.stdout);
  assert.equal(actual.stderr, "");
  return { executable, runtime: executable === "node" ? "node" : "bun",
    version: executable === "node" ? spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim() : Bun.version,
    path: test.path, status: actual.status, stdout: actual.stdout, stderr: actual.stderr };
}

async function browserSmoke(identity: { core: { path: string; sha256: string }; side: { path: string; sha256: string } }, cases: readonly HostCase[], metadataOnly: boolean) {
  const scratch = await mkdtemp(join(tmpdir(), "bw-h5-"));
  let browser: Browser | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    try { await browser?.close(); }
    finally { server?.stop(true); await rm(scratch, { recursive: true, force: true }); }
  })();
  const interrupted = () => { void cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  const timeout = setTimeout(() => { console.error("Hermes host smoke timed out"); interrupted(); }, 120_000);
  let port: number | undefined;
  try {
    // The page's networked root starts the notification relay beside its worker (runner.ts).
    await buildBrowserEntries([join(repository, "web/tests/hermes-host-page.ts"), join(repository, "web/src/worker.ts"), join(repository, "web/src/fs-worker.ts"), join(repository, "web/src/notification-worker.ts")], scratch, { runtimeWorker: true });
    await Bun.write(join(scratch, "index.html"), '<!doctype html><script type="module" src="./hermes-host-page.js"></script>');
    await Bun.write(join(scratch, "engine-builds.json"), JSON.stringify({ "bun-hermes.wasm": identity.core.sha256, "hermes-engine.wasm": identity.side.sha256 }));
    await Bun.write(join(scratch, "fixture.json"), JSON.stringify(await Promise.all(["hello.cts", "module.mts", "dependency.mts", "metadata.mts"].map(async path => ({ path, source: await Bun.file(join(fixtures, path)).text() })))));
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, fetch(request) {
      const name = new URL(request.url).pathname;
      const path = name === "/bun-hermes.wasm" ? identity.core.path : name === "/hermes-engine.wasm" ? identity.side.path : resolve(scratch, `.${name === "/" ? "/index.html" : name}`);
      if ((!path.startsWith(scratch + "/") && path !== identity.core.path && path !== identity.side.path) || !existsSync(path)) return new Response(null, { status: 404, headers });
      return new Response(Bun.file(path), { headers });
    } });
    port = server.port;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?engine=hermes${metadataOnly ? "&metadata=1" : ""}`);
    await page.waitForFunction(() => Reflect.get(globalThis, "hermesHostResult"), undefined, { timeout: 90_000 });
    const result = await page.evaluate(() => Reflect.get(globalThis, "hermesHostResult"));
    assert.equal(result.failure, undefined, JSON.stringify(result));
    assert.equal(result.engine, "hermes");
    assert.equal(result.disposed, true);
    assert.deepEqual(result.results, cases.map(test => ({ path: test.path, outcome: { code: 0 }, stdout: test.stdout, stderr: "" })));
    const memory = await page.evaluate(() => Reflect.get(globalThis, "hermesHostMemory"));
    assert.equal(memory.length, cases.length);
    for (const snapshot of memory) {
      assert.equal(snapshot.engine, "hermes");
      assert.equal(snapshot.jsHeapBytes, null);
      assert.equal(snapshot.arrayBufferBytes, null);
      assert(snapshot.wasmCapacityBytes > 0);
    }
    assert.deepEqual(errors, []);
    return { name: "chromium", version: browser.version(), result, memory };
  } finally {
    clearTimeout(timeout); process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
    await cleanup();
    assert.equal(existsSync(scratch), false);
    if (port) assert.equal(await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false), false);
    console.log(JSON.stringify({ cleanup: { scratchRemoved: true, listenerStopped: true, browserClosed: !browser?.isConnected() } }));
  }
}

if (import.meta.main) {
  const [core, output, option] = process.argv.slice(2);
  if (!core || !output || (option !== undefined && option !== "--node-only" && option !== "--metadata-only")) throw new Error("Usage: hermes-hosts.ts CORE OUTPUT [--node-only|--metadata-only]");
  const result = await verifyHermesHosts(resolve(core), option !== "--node-only", option === "--metadata-only");
  await Bun.write(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
