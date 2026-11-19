import assert from "node:assert/strict";
import { navigateTestPage } from "./navigate-test-page.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit, type BrowserContext } from "playwright";
import { browserBuildConfig, buildClassicWorker } from "../../scripts/browser-build";

const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-navigation-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let context: BrowserContext | undefined;
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try { await context?.close(); }
    finally { await server?.stop(true); await rm(scratch, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const hang = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 240000);

try {
  const entry = resolve(import.meta.dir, "browser-preview-navigation-main.ts");
  const built = await Bun.build(browserBuildConfig([entry], scratch, { splitting: false }));
  assert(built.success, built.logs.map(String).join("\n"));
  const script = built.outputs.find(output => output.path.endsWith(".js"));
  assert(script);
  const sw = await buildClassicWorker(resolve(import.meta.dir, "../src/sw.ts"), scratch, { __PREVIEW_SOCKET_SCRIPT__: '""' }, entry);
  const worker = sw.outputs[0];
  assert(worker);
  const fallbacks: string[] = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const headers = { "cache-control": "no-store", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
    if (path.endsWith("/sw.js")) return new Response(worker, { headers: { ...headers, "content-type": "text/javascript" } });
    if (path.endsWith("/main.js")) return new Response(script, { headers: { ...headers, "content-type": "text/javascript" } });
    if (path.includes("/__preview/")) { fallbacks.push(path); return new Response("Network fallback", { status: 502 }); }
    return new Response('<!doctype html><body><script type="module" src="./main.js"></script></body>', { headers: { ...headers, "content-type": "text/html" } });
  } });
  for (const type of [chromium, webkit]) {
    context = await type.launchPersistentContext(join(scratch, type.name()));
    const page = await context.newPage();
    page.on("console", message => { if (message.type() === "error") console.error(type.name(), message.text()); });
    page.on("pageerror", error => console.error(type.name(), error.message));
    await navigateTestPage(page, server.url.href + "nested/app/");
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "navigationFixture").ready), "ready");
    for (const status of [201, 404]) {
      const target = `/slow-${status}`;
      const preview = await page.evaluate(target => Reflect.get(globalThis, "navigationFixture").url(target), target) + "#kept-fragment";
      await page.evaluate(preview => { const iframe = document.createElement("iframe"); iframe.src = preview; document.body.append(iframe); }, preview);
      await page.frameLocator("iframe").locator('[role="status"]').waitFor().catch(async error => {
        console.error(JSON.stringify(await Promise.all(page.frames().map(async frame => ({ url: frame.url(), html: await frame.content().catch(String) })))));
        throw error;
      });
      const loadingFrame = page.frames().find(frame => frame !== page.mainFrame());
      assert(loadingFrame);
      await Promise.all([loadingFrame.waitForNavigation({ waitUntil: "domcontentloaded" }), loadingFrame.evaluate(() => location.reload())]);
      await page.frameLocator("iframe").locator('[role="status"]').waitFor();
      const started = Date.now();
      // Cross WebKit's native 70-second pre-head watchdog once. This is a regression stimulus.
      await page.waitForTimeout(type === webkit && status === 201 ? 75000 : 0);
      const response = page.waitForResponse(reply => reply.url() === preview.split("#")[0] && reply.status() === status);
      await page.evaluate(({ target, status }) => Reflect.get(globalThis, "navigationFixture").answer(target, status, `Original guest ${status}`), { target, status });
      const delivered = await response;
      assert.equal(delivered.headers()["x-guest-response"], "original");
      assert.equal(delivered.headers()["referrer-policy"], "no-referrer");
      await page.frameLocator("iframe").locator("h1").waitFor();
      assert.equal(await page.frameLocator("iframe").locator("h1").innerText(), `Original guest ${status}`);
      const frame = page.frames().find(frame => frame !== page.mainFrame());
      assert.equal(frame?.url(), preview);
      assert.equal(await page.evaluate(target => Reflect.get(globalThis, "navigationFixture").count(target), target), 1);
      await page.locator("iframe").evaluate(element => element.remove());
      console.log(JSON.stringify({ browser: type.name(), status, headers: "preserved", url: "original", guestRequests: 1, waitMs: Date.now() - started }));
    }
    const abandoned = await page.evaluate(() => Reflect.get(globalThis, "navigationFixture").url("/abandoned"));
    await page.evaluate(preview => { const iframe = document.createElement("iframe"); iframe.src = preview; document.body.append(iframe); }, abandoned);
    await page.frameLocator("iframe").locator('[role="status"]').waitFor();
    const frame = page.frames().find(frame => frame !== page.mainFrame());
    assert(frame);
    const loadingURL = frame.url().split("#")[0];
    await Promise.all([frame.waitForURL("about:blank"), frame.evaluate(() => location.replace("about:blank"))]);
    await page.evaluate(() => Reflect.get(globalThis, "navigationFixture").answer("/abandoned", 200, "Closed preview body"));
    const probe = await context.newPage();
    let state: number | undefined;
    do { state = (await navigateTestPage(probe, loadingURL + "/status"))?.status(); } while (state === 403);
    assert.equal(state, 410);
    await probe.close();
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "navigationFixture").count("/abandoned")), 1);
    await page.locator("iframe").evaluate(element => element.remove());
    console.log(JSON.stringify({ browser: type.name(), navigationAway: "pending response released", guestRequests: 1 }));
    await context.close();
    context = undefined;
  }
  assert.deepEqual(fallbacks, []);
} finally { clearTimeout(hang); await cleanup(); }
