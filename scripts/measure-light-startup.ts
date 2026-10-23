// Serve real production builds, with gzip responses, and measure fresh Chromium processes.
// source env.sh && bun scripts/measure-light-startup.ts --baseline /path/to/old/checkout --output result.json
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpus, loadavg, release } from "node:os";
import { readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium, type Browser, type Page } from "../web/node_modules/playwright";
import { sourceAttribution } from "./measure-light-sources";

interface Capture {
  prompt: number | null;
  spawn: number | null;
  output: number | null;
  complete: number | null;
  timeOrigin: number;
  previewReady: number | null;
  text: string;
  workers: { url: string; at: number }[];
}
declare global { interface Window { lightCapture: Capture } }
interface Download {
  path: string;
  at: number;
  bytes: number;
  gzip: number;
  encoding: string;
}
const { values } = parseArgs({ options: {
  root: { type: "string", default: resolve(import.meta.dir, "..") },
  baseline: { type: "string" }, before: { type: "string" }, "before-revision": { type: "string" }, revision: { type: "string" }, "baseline-revision": { type: "string" }, output: { type: "string" },
  samples: { type: "string", default: "5" }, port: { type: "string", default: "48941" },
} });
const count = Number(values.samples), port = Number(values.port);
assert.ok(Number.isInteger(count) && count > 0 && count <= 20);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const variants = [{ label: "current", root: resolve(values.root) }].concat(values.baseline ? [{ label: "baseline", root: resolve(values.baseline) }] : [], values.before ? [{ label: "before", root: resolve(values.before) }] : []);
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleaning: Promise<void> | undefined;
let downloads: Download[] = [];
const payloads = new Map<string, { raw: Uint8Array; zipped: Uint8Array; type: string }>();
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally { server?.stop(true); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("startup measurement deadline"); void cleanup().finally(() => process.exit(1)); }, count * variants.length * 180_000);

async function serve(request: Request): Promise<Response> {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const [label, app] = pathname.split("/").slice(1);
  const variant = variants.find(variant => variant.label === label);
  if (!variant || (app !== "web" && app !== "sandbox")) return new Response(null, { status: 404 });
  const root = resolve(variant.root, app, "dist");
  const path = resolve(root, pathname.slice(`/${label}/${app}/`.length) || "index.html");
  if (!path.startsWith(root + sep)) return new Response(null, { status: 403 });
  let payload = payloads.get(path);
  if (!payload) {
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("not found", { status: 404 });
    const raw = await file.bytes();
    payload = { raw, zipped: path.endsWith(".gz") ? raw : gzipSync(raw, { level: 9 }), type: file.type };
    payloads.set(path, payload);
  }
  const compressed = !path.endsWith(".gz") && /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "");
  const body = compressed ? payload.zipped : payload.raw;
  downloads.push({ path: pathname, at: Date.now(), bytes: payload.raw.length, gzip: body.length, encoding: compressed ? "gzip" : "identity" });
  return new Response(Buffer.from(body), { headers: {
    "content-type": payload.type, "content-length": String(body.length), "cache-control": "no-cache",
    "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp",
    ...(compressed ? { "content-encoding": "gzip" } : {}),
  } });
}

// Observe the real terminal and workers without replacing fetch, routing requests, or changing bundles.
function instrument(app: string): void {
  const state: Capture = { prompt: null, spawn: null, output: null, complete: null, timeOrigin: performance.timeOrigin, text: "", workers: [], previewReady: null };
  window.lightCapture = state;
  const NativeWorker = Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      state.workers.push({ url: String(url), at: performance.now() });
      this.addEventListener("message", event => {
        if (event.data?.type !== "stdout") return;
        const text = new TextDecoder().decode(event.data.data);
        if (text.includes("LIGHT_OUTPUT_" + "OK")) state.output ??= performance.now();
      });
    }
  };
  new MutationObserver(() => {
    if (app === "sandbox" && document.querySelector<HTMLElement>("#server-dot")?.dataset.state === "up") state.previewReady ??= performance.now();
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  Object.defineProperty(window, app === "web" ? "playground" : "sandbox", {
    configurable: true,
    set(value) {
      Object.defineProperty(window, app === "web" ? "playground" : "sandbox", { value, configurable: true });
      const write = value.term.write.bind(value.term);
      value.term.write = (data: string | Uint8Array, callback?: () => void) => {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (app === "sandbox" && text.includes("bun ./index.html")) state.spawn ??= performance.now();
        else if (app === "sandbox" && state.spawn !== null && text.trim()) state.output ??= performance.now();
        state.text += text;
        return write(data, callback);
      };
      value.term.onWriteParsed(() => {
        const buffer = value.term.buffer.active;
        const text = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString() ?? "").join("\n");
        if (app !== "web" || state.prompt !== null || !text.includes("user@bun:")) return;
        state.prompt = performance.now();
        queueMicrotask(() => {
          state.spawn = performance.now();
          void value.shell.submit('bun -e \'console.log("LIGHT_OUTPUT_" + "OK")\'').then(() => { state.complete = performance.now(); });
        });
      });
    },
  });
}

async function webCommand(page: Page): Promise<void> {
  await page.waitForFunction(() => window.lightCapture.complete !== null);
  assert.ok(await page.evaluate(() => window.lightCapture.output !== null), "bun -e must print the sentinel");
}

const totals = (rows: readonly Download[]) => rows.reduce((total, row) => ({ bytes: total.bytes + row.bytes, gzip: total.gzip + row.gzip }), { bytes: 0, gzip: 0 });
async function summarize(rows: Download[], capture: Capture, root: string, app: string, label: string) {
  const relative = rows.map(row => ({ ...row, path: row.path.slice(`/${label}/${app}/`.length), at: row.at - capture.timeOrigin }));
  const split = capture.spawn;
  assert.ok(split !== null, "first spawn observed");
  const initial = relative.filter(row => row.at < split);
  const spawned = relative.filter(row => row.at >= split);
  const js = relative.filter(row => row.path.endsWith(".js"));
  const files = await Promise.all(Array.from(new Set(js.map(row => row.path)), async path => {
    const code = await Bun.file(resolve(root, app, "dist", path)).text();
    return { path, sha256: createHash("sha256").update(code).digest("hex"), ...await sourceAttribution(resolve(root, app, "dist", path), code) };
  }));
  const beforeFiles = files.filter(file => initial.some(row => row.path === file.path));
  const runtimeBytes = (rows: typeof relative) => rows.reduce((total, row) => {
    const file = files.find(file => file.path === row.path);
    return { bytes: total.bytes + (file?.runtime?.bytes ?? 0), gzip: total.gzip + (file?.runtime?.gzip ?? 0) };
  }, { bytes: 0, gzip: 0 });
  return {
    promptMs: capture.prompt, firstSpawnMs: capture.spawn, firstOutputMs: capture.output,
    spawnToOutputMs: capture.output === null ? null : capture.output - split,
    commandCompleteMs: capture.complete, previewReadyMs: capture.previewReady, workers: capture.workers,
    beforeSpawn: { all: totals(initial), javascript: totals(initial.filter(row => row.path.endsWith(".js"))) },
    firstSpawnAdditional: { all: totals(spawned), javascript: totals(spawned.filter(row => row.path.endsWith(".js"))) },
    afterSpawnCumulative: { all: totals(relative), javascript: totals(js) },
    runtimeAttribution: { beforeSpawn: runtimeBytes(initial), afterSpawn: runtimeBytes(relative) },
    initialProcessService: beforeFiles.filter(file => file.processService.length).map(file => ({ path: file.path, sources: file.processService })),
    workerDemoUi: files.filter(file => file.path !== "main.js" && file.uiSources.length).map(file => ({ path: file.path, sources: file.uiSources })),
    downloads: relative, files,
  };
}

async function sample(variant: typeof variants[number], app: string) {
  launching = chromium.launch({ headless: true });
  browser = await launching;
  launching = undefined;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(instrument, app);
  downloads = [];
  const url = `http://127.0.0.1:${port}/${variant.label}/${app}/?engine=browser`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (app === "web") await webCommand(page);
    else await page.waitForFunction(() => document.querySelector<HTMLElement>("#server-dot")?.dataset.state === "up");
    // Drain follow-on chunk and SW requests, including sandbox preview loading.
    await page.waitForTimeout(300);
    const capture = await page.evaluate(() => window.lightCapture);
    assert.deepEqual(errors, [], "no page errors");
    const result = await summarize(downloads, capture, variant.root, app, variant.label);
    return { label: variant.label, app, chromium: browser.version(), ...result };
  } catch (error) {
    console.error({ label: variant.label, app, errors, status: await page.locator("#status").textContent(), capture: await page.evaluate(() => window.lightCapture) });
    throw error;
  } finally { await context.close(); await browser.close(); browser = undefined; }
}

async function provenance(root: string, revision?: string) {
  const git = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe" });
  const assets = await Promise.all(["web", "sandbox"].map(async app => {
    const bytes = await Bun.file(resolve(root, app, "dist/bun-browser.wasm.gz")).bytes();
    return { app, gzipBytes: bytes.length, sha256: createHash("sha256").update(Bun.gunzipSync(bytes)).digest("hex") };
  }));
  return { root, commit: revision ?? git.stdout.toString().trim(), assets };
}
async function measureVariants(order: typeof variants, iteration: number) {
  const results = [];
  for (const variant of order) for (const app of ["web", "sandbox"]) {
    console.error(`sample ${iteration + 1}: ${variant.label}/${app}`);
    results.push(await sample(variant, app));
  }
  return results;
}

async function preload(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) { await preload(path); continue; }
    if (!/\.(?:js|css|html|json|gz)$/.test(path)) continue;
    const file = Bun.file(path), raw = await file.bytes();
    payloads.set(path, { raw, zipped: path.endsWith(".gz") ? raw : gzipSync(raw, { level: 9 }), type: file.type });
  }
}

try {
  for (const variant of variants) for (const app of ["web", "sandbox"]) await preload(resolve(variant.root, app, "dist"));
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch: serve });
  const samples = [];
  for (let iteration = 0; iteration < count; iteration++) {
    const order = iteration % 2 ? variants.toReversed() : variants;
    samples.push(...await measureVariants(order, iteration));
  }
  const report = {
    date: new Date().toISOString(), environment: { cpu: cpus()[0]?.model, kernel: release(), bun: Bun.version, load: loadavg() },
    method: "Cold browser process/context per sample; production builds, actual loopback HTTP gzip level 9 response bodies logged by server across page, dedicated workers and service workers. No request interception, mocks, bundler-size substitution, network throttling or OS page-cache flush. Compression happens before navigation, not on the request path. Alternating revision order. Before spawn is shell submission or sandbox command banner. Sandbox has no shell prompt; its first output belongs to the auto-started dev server, not bun -e. 300ms follow-on observation. Source-map spans are attribution estimates; gzip fragments are NOT wire bytes. Default persistent filesystem and React sandbox. Headers match isolated local preview with JS/HTML/template gzip added.",
    variants: await Promise.all(variants.map(async variant => ({ label: variant.label, ...await provenance(variant.root, variant.label === "current" ? values.revision : variant.label === "before" ? values["before-revision"] : values["baseline-revision"]) }))), samples,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) await Bun.write(values.output, json); else console.log(json);
} finally {
  clearTimeout(deadline);
  await cleanup();
  assert.equal(await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false), false, "owned listener stopped on actual host");
}
