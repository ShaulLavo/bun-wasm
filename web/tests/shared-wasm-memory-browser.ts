// Runs the shared Wasm memory fixture in a real shared-group QuickJS guest on the production
// Browser host. No mock: Chromium instantiates the group core and side through Waffle's worker.
// source env.sh && BUN_WASM_PROFILE_PROGRAM=<group>/bun.wasm bun web/tests/shared-wasm-memory-browser.ts chromium
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Browser, BrowserType, Page } from "playwright";
import { programKind, programProfile, sharedGroupPair } from "../../src/engine-kind.ts";
import { stageFixtureTree } from "../../scripts/fixture-tree";
import { oxcOutputs, oxcTreeVariable, requireOxcEnvironment, requireOxcTree } from "../../scripts/real-oxc-consumer";
import { buildBrowserEntries } from "../../scripts/browser-build";

const web = resolve(import.meta.dir, "..");
const repository = resolve(web, "..");
const fixtureSource = join(repository, "tests/fixtures/shared-wasm-memory");
const oxcTree = process.env[oxcTreeVariable];

let scratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let cleaning: Promise<void> | undefined;
const originalTmp = process.env.TMPDIR;

const cleanup = () => cleaning ??= (async () => {
  try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
  finally {
    server?.stop(true);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
  }
})();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("shared Wasm memory browser deadline"); void cleanup().finally(() => process.exit(1)); }, 300_000);

async function prepareSite(program: string): Promise<string> {
  const coreBytes = await Bun.file(program).bytes();
  const core = new WebAssembly.Module(coreBytes);
  const kind = programKind(core);
  if (kind === "single") throw new Error("The shared Browser fixture requires a paired core");
  const sideBytes = await Bun.file(join(dirname(program), programProfile(kind).side)).bytes();
  assert.equal(sharedGroupPair(core, sideBytes), true, "The selected Browser host program must be a shared-group pair");
  const base = process.env.RUNNER_TEMP ?? (await stat("/work/tmp").then(() => "/work/tmp", () => originalTmp ?? "/tmp"));
  scratch = await mkdtemp(join(base, "bun-wasm-shared-memory-browser-"));
  process.env.TMPDIR = scratch;
  const out = join(scratch, "site");
  console.log(JSON.stringify({ resources: { scratch, listener: "ephemeral loopback port", downloads: "none", program } }));
  await buildBrowserEntries([join(web, "tests/shared-wasm-memory-browser-main.ts"), join(web, "tests/shared-wasm-agent/worker.ts"), join(web, "src/fs-worker.ts"), join(web, "src/notification-worker.ts")], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./shared-wasm-memory-browser-main.js"></script>');
  if (oxcTree !== undefined) requireOxcTree(oxcTree);
  const entries = await stageFixtureTree(oxcTree ?? fixtureSource, join(out, "fixture"));
  await Bun.write(join(out, "fixture-manifest.json"), JSON.stringify(entries));
  await mkdir(join(out, "program"));
  await Bun.write(join(out, "program/bun.wasm"), coreBytes);
  await Bun.write(join(out, "program/side.wasm"), sideBytes);
  await Bun.write(join(out, "program/kind.json"), JSON.stringify(kind));
  return out;
}

function serve(out: string): number {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    const path = resolve(out, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  return server.port!;
}

type OwnerCounters = { members: number; retained: number; regions: number; holds: number; pins: number; watches: number; published: number };
type Result = { done: true; thrown?: string; code?: number; error?: string; stdout?: string; stderr?: string; wallMs?: number; peak?: { groups: number; regions: number; holds: number; committedBytes: number }; groups?: readonly OwnerCounters[]; ended?: readonly OwnerCounters[]; budget?: number; agentCloseDelays?: Readonly<Record<string, number>> };
const DEBT_ENTRY = "failed-stop.ts";

/** Every owner this run created has ended and holds nothing; the page budget is back to zero. */
function assertRetired(value: Result): void {
  assert.ok((value.ended?.length ?? 0) > 0, "the run never observed a group owner");
  for (const { members, retained, regions, holds, pins, watches, published } of value.ended!) {
    assert.deepEqual({ members, retained, regions, holds, pins, watches, published }, { members: 0, retained: 0, regions: 0, holds: 0, pins: 0, watches: 0, published: 0 });
  }
  assert.equal(value.budget, 0, "the page budget is released with the last group");
}

async function result(page: Page): Promise<Result> {
  // A blocked guest cannot explain itself, so the page reports what it has seen so far.
  const report = () => void page.evaluate(() => Reflect.get(globalThis, "sharedWasmMemoryProgress")?.()).then(progress => console.log(JSON.stringify({ progress })), () => {});
  const progress = setInterval(report, 20_000);
  try {
    await page.waitForFunction(() => Reflect.get(globalThis, "sharedWasmMemoryResult"), undefined, { timeout: oxcTree === undefined ? 240_000 : 90_000 });
    return await page.evaluate(() => Reflect.get(globalThis, "sharedWasmMemoryResult"));
  } finally { clearInterval(progress); }
}

interface EntryRun { readonly value: Result; readonly pageErrors: readonly string[]; }

async function runEntry(name: string, port: number, entry: string): Promise<EntryRun> {
  const page = await browser!.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?entry=${encodeURIComponent(entry)}${oxcTree === undefined ? "" : "&oxc=1"}`);
  const value = await result(page);
  console.log(JSON.stringify({ browser: name, version: browser!.version(), entry, ...value, pageErrors }));
  await page.close();
  return { value, pageErrors };
}

async function assertClean({ value, pageErrors }: EntryRun): Promise<void> {
  assert.equal(value.thrown, undefined, String(value.thrown));
  assert.equal(value.code, 0, value.stderr ?? String(value.error));
  assert.equal(value.stdout, await readFile(join(fixtureSource, "expected-browser.txt"), "utf8"));
  assert.deepEqual(pageErrors, []);
  assert.ok((value.peak?.regions ?? 0) > 0, "the owner never saw a real nested region");
  assert.ok((value.peak?.committedBytes ?? 0) > 0, "the owner never charged group backing");
  assert.deepEqual(value.groups, [], "members, regions, holds and pins are released after the supported stop");
  assertRetired(value);
}

/** A failed native stop keeps its member, publication and charge: the group cannot end. */
function assertDebt({ value }: EntryRun): void {
  assert.equal(value.thrown, undefined, String(value.thrown));
  assert.equal(value.code, 0, value.stderr ?? String(value.error));
  assert.equal(value.stdout, "shared-wasm-memory failed stop: pass\n");
  assert.equal(value.groups?.length, 1, "the group with debt stays live");
  const [group] = value.groups!;
  assert.equal(group!.retained, 1);
  assert.equal(group!.members, 0);
  assert.ok(group!.published > 0, "the failed member's publication is kept");
  assert.ok(group!.regions > 0, "the failed member's regions are kept");
  assert.ok((value.budget ?? 0) > 0, "the failed member's backing stays charged");
}

function assertOxc(entry: string, { value, pageErrors }: EntryRun): void {
  assert.equal(value.thrown, undefined, String(value.thrown));
  assert.equal(value.code, 0, value.stderr ?? String(value.error));
  assert.ok(entry === "index.ts" || entry === "direct.ts");
  assert.equal(value.stdout, oxcOutputs[entry]);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(value.groups, [], "the Oxc group is released after the supported stop");
  assertRetired(value);
}

async function runBrowser(type: BrowserType, name: string, port: number): Promise<void> {
  launching = type.launch({ headless: true, downloadsPath: join(scratch!, "downloads") });
  browser = await launching;
  const override = process.env.SHARED_WASM_ENTRY;
  const entries = oxcTree !== undefined ? Object.keys(oxcOutputs) : override ? [override] : ["browser-guest.ts", DEBT_ENTRY];
  const runs = [];
  for (const entry of entries) runs.push({ entry, run: await runEntry(name, port, entry) });
  await browser.close();
  browser = undefined;
  launching = undefined;
  if (process.env.SHARED_WASM_CONTROL) { console.log(`control ${process.env.SHARED_WASM_CONTROL} observed`); return; }
  for (const { entry, run } of runs) {
    if (oxcTree !== undefined) assertOxc(entry, run);
    else if (entry === DEBT_ENTRY) assertDebt(run);
    else await assertClean(run);
  }
}

try {
  if (oxcTree !== undefined) {
    const env = { ...process.env };
    delete env[oxcTreeVariable];
    requireOxcEnvironment(env);
  }
  const program = process.env.BUN_WASM_PROFILE_PROGRAM;
  if (!program) throw new Error("Set BUN_WASM_PROFILE_PROGRAM to a matching shared-group core; a missing guest is a failure");
  const playwright = await import("playwright");
  const types = { chromium: playwright.chromium, firefox: playwright.firefox, webkit: playwright.webkit };
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"];
  const out = await prepareSite(resolve(program));
  const port = serve(out);
  for (const name of names) {
    assert.ok(name in types, `unknown browser ${name}`);
    await runBrowser(types[name as keyof typeof types], name, port);
  }
} finally {
  clearTimeout(deadline);
  await cleanup();
}
