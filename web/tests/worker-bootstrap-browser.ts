// source env.sh && bun /work/platform-production/heavy/current/run.js --class browser \
//   bun-worker-bootstrap -- bun web/tests/worker-bootstrap-browser.ts chromium firefox webkit
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Browser } from "playwright";
import { buildBrowserEntries } from "../../scripts/browser-build.js";

let scratch: string | undefined, server: ReturnType<typeof Bun.serve> | undefined, browser: Browser | undefined;
let launching: Promise<Browser> | undefined, cleaning: Promise<void> | undefined, creatingScratch: Promise<string> | undefined;
const originalTmp = process.env.TMPDIR;
// Pre-existing packages/browser caches are read-only. The listener, profile, browser and bundle
// below are this run's only resources; teardown is installed before creating any of them.
const cleanup = () => cleaning ??= (async () => {
  try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
  finally {
    server?.stop(true);
    const directory = scratch ?? await creatingScratch?.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
  }
})();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("worker bootstrap browser deadline"); void cleanup().finally(() => process.exit(1)); }, 120_000);
let port: number | undefined;
try {
  const { chromium, firefox, webkit } = await import("playwright");
  const types = { chromium, firefox, webkit };
  const names = process.argv.slice(2); if (!names.length) names.push("chromium");
  for (const name of names) assert.ok(name in types && existsSync(types[name as keyof typeof types].executablePath()), `cached browser required: ${name}`);
  scratch = await (creatingScratch = mkdtemp("/work/tmp/bw-boot-")); process.env.TMPDIR = scratch;
  console.log(JSON.stringify({ resources: { created: [scratch, "ephemeral listener", "browser/profile"], downloads: "none", existing: "installed packages and shared browser caches" } }));
  await buildBrowserEntries([join(import.meta.dir, "worker-bootstrap-browser-main.ts"), resolve(import.meta.dir, "../src/worker.ts")], scratch, { runtimeWorker: true });
  await Bun.write(join(scratch, "index.html"), '<!doctype html><script type="module" src="./worker-bootstrap-browser-main.js"></script>');
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    const path = resolve(scratch!, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(scratch! + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  port = server.port;
  for (const name of names) {
    launching = types[name as keyof typeof types].launch({ headless: true, downloadsPath: join(scratch, "downloads") }); browser = await launching;
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => Reflect.get(globalThis, "workerBootstrapResult"), undefined, { timeout: 30_000 });
      const result = await page.evaluate(() => Reflect.get(globalThis, "workerBootstrapResult"));
      console.log(JSON.stringify({ browser: name, version: browser.version(), result, pageErrors: errors }));
      assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(errors, []);
    } finally { await page.close(); }
    await browser.close(); browser = undefined; launching = undefined;
  }
} finally {
  clearTimeout(deadline); await cleanup();
  assert.equal(scratch ? existsSync(scratch) : false, false, "scratch removed on execution host");
  if (port) assert.equal(await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false), false, "listener stopped on execution host");
  console.log(JSON.stringify({ cleanup: { scratchRemoved: true, listenerStopped: true, browsersClosed: true } }));
}
