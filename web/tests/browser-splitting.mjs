// Real scoped module-worker regression; no Rust, WASM, app dist, or template install.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { buildBrowserEntries, buildClassicWorker } from "../../scripts/browser-build.ts";

let server;
let browser;
let browserLaunch;
let scratch;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await browserLaunch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}
const timeout = setTimeout(() => {
  console.error("Split-worker smoke exceeded 60 seconds");
  void cleanup().finally(() => process.exit(1));
}, 60_000);

try {
  const port = Number(process.env.SPLIT_SMOKE_PORT ?? 4180);
  assert.equal(execFileSync("ss", ["-H", "-ltn", `sport = :${port}`], { encoding: "utf8" }).trim(), "", `Port ${port} is already in use`);
  // Only this directory, server, browser and profile belong to this test.
  scratch = await mkdtemp(resolve(import.meta.dir, "../node_modules/.browser-splitting-"));
  process.env.TMPDIR = scratch;
  const out = join(scratch, "dist");
  await Bun.write(join(scratch, "shared.ts"), "export const shared = (value: string) => value.toUpperCase();");
  await Bun.write(join(scratch, "lazy.ts"), "export const lazy = 'dynamic chunk';");
  await Bun.write(join(scratch, "main.ts"), "import { shared } from './shared'; globalThis.pageResult = shared('page');");
  await Bun.write(join(scratch, "worker.ts"), "import { shared } from './shared'; postMessage({ value: shared('worker'), lazy: (await import('./lazy')).lazy, controlled: Boolean(navigator.serviceWorker.controller) });");
  await Bun.write(join(scratch, "sw.ts"), "import { shared } from './shared'; self.addEventListener('install', event => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('message', event => event.source.postMessage(shared('classic')));");
  const split = await buildBrowserEntries([join(scratch, "main.ts"), join(scratch, "worker.ts")], out);
  assert.ok(split.outputs.filter((output) => output.kind === "chunk").length >= 2, "Fixture must exercise shared and dynamic chunks");
  await buildClassicWorker(join(scratch, "sw.ts"), out);
  // Also run the real classic SW's module-scope proxy, without the unrelated preview client.
  const productionSW = await buildClassicWorker(resolve(import.meta.dir, "../src/sw.ts"), join(scratch, "production-sw"), { __PREVIEW_SOCKET_SCRIPT__: '""' });
  await Bun.write(join(out, "production-sw.js"), productionSW.outputs[0]);
  await Bun.write(join(out, "index.html"), '<!doctype html><title>Split-worker smoke</title><script type="module" src="./main.js"></script>');
  const requests = [];
  server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      const local = path.replace(/^\/nested\/app\//, "/");
      const file = resolve(out, `.${local.endsWith("/") ? `${local}index.html` : local}`);
      if (!file.startsWith(out + sep) || !(await Bun.file(file).exists())) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(file), { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
    },
  });
  browserLaunch = chromium.launch({
    headless: true, timeout: 30_000,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces"),
  });
  browser = await browserLaunch;
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  for (const prefix of ["/", "/nested/app/"]) {
    await page.goto(`http://127.0.0.1:${port}${prefix}`, { waitUntil: "load" });
    const result = await page.evaluate(async (script) => {
      const registration = await navigator.serviceWorker.register(script, { scope: "./__bunwasm/" });
      const active = registration.active ?? registration.installing ?? registration.waiting;
      if (!active) throw new Error("Missing classic service worker");
      if (active.state !== "activated") await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Service worker activation timed out")), 10_000);
        active.addEventListener("statechange", () => {
          if (active.state === "activated") { clearTimeout(timer); resolve(); }
          if (active.state === "redundant") { clearTimeout(timer); reject(new Error("Classic service worker failed")); }
        });
      });
      const workerResult = await new Promise((resolve, reject) => {
        const worker = new Worker("./__bunwasm/worker.js", { type: "module" });
        const timer = setTimeout(() => { worker.terminate(); reject(new Error("Split worker timed out")); }, 10_000);
        worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
        worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
      });
      return { page: globalThis.pageResult, worker: workerResult };
    }, prefix === "/" ? "./sw.js" : "./production-sw.js");
    assert.deepEqual(result, { page: "PAGE", worker: { value: "WORKER", lazy: "dynamic chunk", controlled: true } });
    assert.ok(requests.some((path) => path.startsWith(`${prefix}chunks/`)), "Page must fetch its shared chunk");
    if (prefix === "/") {
      assert.ok(requests.filter((path) => path.startsWith(`${prefix}__bunwasm/chunks/`)).length >= 2, "Scoped worker must fetch shared and dynamic chunks directly when SW does not proxy");
    } else {
      assert.ok(requests.filter((path) => path.startsWith(`${prefix}chunks/`)).length >= 2, "Production SW must resolve worker chunks against the nested app root");
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(!requests.some((path) => path.endsWith(".map")));
  console.log(`Chromium ${browser.version()}: split page and scoped module worker, static/dynamic chunks, classic service worker, root/nested hosting passed`);
} finally {
  clearTimeout(timeout);
  await cleanup();
}
