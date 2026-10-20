// Real product pages and Waffle workers. Run after building web/ and sandbox/.
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import type { SharedFilesystem } from "../src/shared-fs";

declare global {
  interface Window {
    playground?: { fs: SharedFilesystem };
    sandbox?: { fs: SharedFilesystem };
  }
}
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleaning: Promise<void> | undefined;
let ownedPort: number | undefined;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally { server?.stop(true); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 180_000);
const report: unknown[] = [];

async function startup(page: Page, url: string, app: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(app => !!(app === "web" ? window.playground : window.sandbox), app);
}

async function checkUnsupportedMode(page: Page, root: string, app: string, selected: string): Promise<void> {
  await page.goto(`${root}?mode=${selected}${app === "sandbox" ? "&template=vanilla" : ""}`);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")?.dataset.kind === "error");
  assert.match(await page.locator("#status").innerText(), /UNSUPPORTED_VFS/);
  assert.match(await page.locator("#status").innerText(), new RegExp(selected));
  assert.equal(await page.locator(app === "web" ? "#run" : "#restart").isEnabled(), true);
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name)), []);
  report.push({ app, mode: selected, error: await page.locator("#status").innerText(), databases: [] });
}

async function checkModes(app: string): Promise<void> {
  const context = await browser!.newContext();
  const page = await context.newPage();
  const root = `http://127.0.0.1:${server!.port}/${app}/`;
  const expectedName = app === "web" ? "bun-wasm-workspace" : "bun-wasm-sandbox-vanilla";
  const base = app === "web" ? root : `${root}?template=vanilla`;
  const query = app === "web" ? "?" : "?template=vanilla&";
  try {
    for (const selected of ["safe", "invalid"]) await checkUnsupportedMode(page, root, app, selected);
    await startup(page, `${root}?mode=memory${app === "sandbox" ? "&template=vanilla" : ""}`, app);
    assert.equal(await page.evaluate(app => (app === "web" ? window.playground : window.sandbox)!.fs.vfs.mode, app), "memory");
    await page.evaluate(async app => { const fs = (app === "web" ? window.playground : window.sandbox)!.fs; await fs.writeFile("/mode-check", "volatile"); await fs.flush(); }, app);
    await page.reload();
    await page.waitForFunction(app => !!(app === "web" ? window.playground : window.sandbox), app);
    assert.equal(await page.evaluate(async app => !!await (app === "web" ? window.playground : window.sandbox)!.fs.lookup("/mode-check"), app), false);
    await startup(page, base, app);
    assert.equal(await page.evaluate(app => (app === "web" ? window.playground : window.sandbox)!.fs.vfs.mode, app), "fast");
    await page.evaluate(async app => { const fs = (app === "web" ? window.playground : window.sandbox)!.fs; await fs.writeFile("/mode-check", "saved"); await fs.flush(); }, app);
    assert.ok((await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).includes(expectedName));
    await page.reload();
    await page.waitForFunction(app => !!(app === "web" ? window.playground : window.sandbox), app);
    assert.equal(await page.evaluate(async app => new TextDecoder().decode(await (app === "web" ? window.playground : window.sandbox)!.fs.readFile("/mode-check")), app), "saved");
    report.push({ app, default: "fast", memoryReload: "empty", fastReload: "saved", workspace: expectedName });
    // Remove a required browser capability in the real filesystem worker before it loads.
    await page.route(/\/fs-worker\.js$/, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: 'Object.defineProperty(globalThis,"indexedDB",{value:undefined});\n' + await response.text() });
    });
    await page.goto(`${root}${query}mode=fast`);
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")?.textContent?.includes("UNSUPPORTED_VFS_CAPABILITY"), undefined, { timeout: 10_000 }).catch(async error => { console.error({ app, url: page.url(), status: await page.locator("#status").innerText() }); throw error; });
    report.push({ app, workerFailure: await page.locator("#status").innerText() });
  } finally { await context.close(); }
}

try {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const app = url.pathname.split("/")[1];
    if (app !== "web" && app !== "sandbox") return new Response(null, { status: 404 });
    const root = resolve(import.meta.dir, "../..", app, "dist");
    const path = resolve(root, url.pathname.slice(app.length + 2) || "index.html");
    if (!path.startsWith(root + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404 });
    return new Response(Bun.file(path), { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
  } });
  ownedPort = server.port;
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    assert.ok(name === "chromium" || name === "webkit");
    launching = (name === "chromium" ? chromium : webkit).launch({ headless: true });
    browser = await launching;
    launching = undefined;
    await checkModes("web");
    await checkModes("sandbox");
    report.push({ browser: name, version: browser.version() });
    await browser.close(); browser = undefined;
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(deadline);
  await cleanup();
  if (ownedPort) {
    const probe = Bun.connect({ hostname: "127.0.0.1", port: ownedPort, socket: { data() {}, open(socket) { socket.end(); } } });
    assert.equal(await probe.then(() => true, () => false), false, "owned listener released on actual host");
  }
  console.log(JSON.stringify({ cleanup: { browsersClosed: true, listenerStopped: true } }));
}
