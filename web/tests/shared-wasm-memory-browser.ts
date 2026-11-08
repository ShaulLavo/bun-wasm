// Runs the shared Wasm memory fixture in a real shared-group QuickJS guest on the production
// Browser host. No mock: Chromium instantiates the group core and side through Waffle's worker.
// source env.sh && BUN_WASM_PROFILE_PROGRAM=<group>/bun.wasm bun web/tests/shared-wasm-memory-browser.ts chromium
import { strict as assert } from "node:assert";
import { copyFile, cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Browser, Page } from "playwright";
import { buildBrowserEntries } from "../../scripts/browser-build";

const web = resolve(import.meta.dir, "..");
const repository = resolve(web, "..");
const fixtureSource = join(repository, "tests/fixtures/shared-wasm-memory");

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
  const base = process.env.RUNNER_TEMP ?? (await stat("/work/tmp").then(() => "/work/tmp", () => originalTmp ?? "/tmp"));
  scratch = await mkdtemp(join(base, "bun-wasm-shared-memory-browser-"));
  process.env.TMPDIR = scratch;
  const out = join(scratch, "site");
  console.log(JSON.stringify({ resources: { scratch, listener: "ephemeral loopback port", downloads: "none", program } }));
  await buildBrowserEntries([join(web, "tests/shared-wasm-memory-browser-main.ts"), join(web, "src/worker.ts"), join(web, "src/fs-worker.ts"), join(web, "src/notification-worker.ts")], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./shared-wasm-memory-browser-main.js"></script>');
  await cp(fixtureSource, join(out, "fixture"), { recursive: true });
  const names = (await readdir(fixtureSource)).filter(name => name.endsWith(".ts") || name.endsWith(".wasm"));
  await Bun.write(join(out, "fixture/index.json"), JSON.stringify(names));
  await copyFile(program, join(out, "program/bun.wasm")).catch(async () => { await Bun.write(join(out, "program/.keep"), ""); await copyFile(program, join(out, "program/bun.wasm")); });
  await copyFile(join(dirname(program), "quickjs.wasm"), join(out, "program/quickjs.wasm"));
  return out;
}

function serve(out: string): number {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    const path = resolve(out, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  return server.port!;
}

type Result = { done: true; thrown?: string; code?: number; error?: string; stdout?: string; stderr?: string; wallMs?: number; groups?: readonly { members: number; retained: number; regions: number; holds: number; pins: number; watches: number }[] };

async function result(page: Page): Promise<Result> {
  await page.waitForFunction(() => Reflect.get(globalThis, "sharedWasmMemoryResult"), undefined, { timeout: 240_000 });
  return page.evaluate(() => Reflect.get(globalThis, "sharedWasmMemoryResult"));
}

try {
  const program = process.env.BUN_WASM_PROFILE_PROGRAM;
  if (!program) throw new Error("Set BUN_WASM_PROFILE_PROGRAM to a matching shared-group core; a missing guest is a failure");
  const { chromium } = await import("playwright");
  const names = process.argv.slice(2);
  assert.deepEqual(names.length ? names : ["chromium"], ["chromium"], "only Chromium is qualified for this gate");
  const out = await prepareSite(resolve(program));
  const port = serve(out);
  launching = chromium.launch({ headless: true, downloadsPath: join(scratch!, "downloads") });
  browser = await launching;
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.message));
  const entry = process.env.SHARED_WASM_ENTRY ?? "browser-guest.ts";
  await page.goto(`http://127.0.0.1:${port}/?entry=${encodeURIComponent(entry)}`);
  const value = await result(page);
  console.log(JSON.stringify({ browser: browser.version(), ...value, pageErrors: consoleErrors }));
  if (process.env.SHARED_WASM_CONTROL) {
    console.log(`control ${process.env.SHARED_WASM_CONTROL} observed`);
  } else {
    assert.equal(value.thrown, undefined, value.thrown);
    assert.equal(value.code, 0, value.stderr ?? value.error);
    assert.equal(value.stdout, await readFile(join(fixtureSource, "expected-browser.txt"), "utf8"));
    assert.deepEqual(consoleErrors, []);
    for (const group of value.groups ?? []) {
      assert.deepEqual([group.members, group.retained, group.regions, group.holds, group.pins, group.watches], [0, 0, 0, 0, 0, 0], JSON.stringify(group));
    }
  }
} finally {
  clearTimeout(deadline);
  await cleanup();
}
