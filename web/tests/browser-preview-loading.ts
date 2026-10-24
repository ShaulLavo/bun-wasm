// Artifact-free request regression for the demos' independent module/preview scopes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { browserBuildConfig, buildClassicWorker } from "../../scripts/browser-build";
import { previewWebsocketScript } from "../preview-build";

const port = Number(process.env.PREVIEW_LOADING_PORT ?? 48960);
const names = process.argv.slice(2);
assert.ok(names.length > 0 && names.every(name => name === "chromium" || name === "webkit"));
let scratch: string | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally { server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 180_000);
const requests: string[] = [];

async function exercise(prefix: string) {
  assert.ok(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const scopes = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(value => new URL(value.scope).pathname).sort());
  try {
    const start = requests.length;
    await page.goto(`http://127.0.0.1:${port}${prefix}`);
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "previewLoading").moduleReady), true);
    assert.deepEqual(await scopes(), [`${prefix}__bunwasm/`], "no eager preview registration");
    assert.deepEqual(requests.slice(start).filter(path => path.endsWith("/sw.js")), [`${prefix}sw.js`]);
    assert.deepEqual(await page.evaluate(async () => Promise.all([
      Reflect.get(globalThis, "previewLoading").ready(), Reflect.get(globalThis, "previewLoading").ready(),
    ])), ["ready", "ready"]);
    assert.deepEqual(await scopes(), [`${prefix}__bunwasm/`, `${prefix}__preview/`]);
    assert.deepEqual(requests.slice(start).filter(path => path.endsWith("/sw.js")), [`${prefix}sw.js`, `${prefix}sw.js`]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ prefix, initialRequests: 1, eventualRequests: 2, scopes: await scopes(), errors }));
  } finally { await context.close(); }
}

try {
  scratch = await mkdtemp(join(process.env.SCRATCH ?? tmpdir(), "bun-wasm-preview-loading-"));
  const entry = resolve(import.meta.dir, "browser-preview-loading-main.ts");
  const config = browserBuildConfig([entry], scratch, { splitting: false });
  const built = await Bun.build(config);
  assert.ok(built.success, built.logs.map(String).join("\n"));
  const script = built.outputs.find(output => output.path.endsWith(".js"));
  assert.ok(script);
  const sw = await buildClassicWorker(resolve(import.meta.dir, "../src/sw.ts"), scratch, {
    __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(await previewWebsocketScript()),
  }, entry);
  const worker = sw.outputs[0];
  assert.ok(worker);
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    const headers = { "cache-control": "no-store", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
    if (path.endsWith("/sw.js")) return new Response(worker, { headers: { ...headers, "content-type": "text/javascript" } });
    if (path.endsWith("/main.js")) return new Response(script, { headers: { ...headers, "content-type": "text/javascript" } });
    if (path.endsWith("/")) return new Response('<!doctype html><script type="module" src="./main.js"></script>', { headers: { ...headers, "content-type": "text/html" } });
    return new Response(null, { status: 404 });
  } });
  for (const name of names) {
    const type = name === "chromium" ? chromium : webkit;
    launching = type.launch({ headless: true });
    browser = await launching;
    launching = undefined;
    await exercise("/");
    await exercise("/nested/app/");
    await browser.close();
    browser = undefined;
  }
} finally { clearTimeout(deadline); await cleanup(); }
