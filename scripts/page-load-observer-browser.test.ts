import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, firefox, type Browser } from "playwright";
import { installPageLoadObserver, type PageLoadState } from "../sandbox/tests/page-load-support";

declare const __pageLoad: { state(app: string): PageLoadState };

// The profiler's readiness observer, in the two browsers it profiles.
const pages: Record<string, string> = {
  // A playground from before the stage marks: only #status says when it is ready.
  "/unmarked": `<span id="status" data-kind="">loading…</span><script>setTimeout(() => {
    const status = document.querySelector("#status"); status.textContent = "bun.wasm ready · Browser"; status.dataset.kind = "ok";
  }, 30)</script>`,
  "/marked": `<span id="status" data-kind="">loading…</span><script>setTimeout(() => {
    performance.mark("bunwasm:status", { detail: "bun.wasm ready · Browser" });
    globalThis.markedAt = performance.getEntriesByName("bunwasm:status")[0].startTime;
  }, 30)</script>`,
  "/failed": `<span id="status" data-kind="">loading…</span><script>setTimeout(() => {
    const status = document.querySelector("#status"); status.textContent = "could not load bun.wasm"; status.dataset.kind = "error";
  }, 30)</script>`,
};

const browsers: Browser[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new Response(pages[new URL(request.url).pathname] ?? "", { headers: { "content-type": "text/html" } }) });
beforeAll(async () => {
  try {
    browsers.push(await chromium.launch({ headless: true }), await firefox.launch({ headless: true }));
  } catch (error) {
    await Promise.all(browsers.map(browser => browser.close()));
    throw error;
  }
}, 120_000);
// Closing Firefox can take several seconds on a busy host; this only caps a hang.
afterAll(async () => {
  await Promise.all(browsers.map(browser => browser.close()));
  await server.stop(true);
}, 60_000);

test("page readiness comes from the page's marks, or from #status on builds without them", async () => {
  for (const browser of browsers) {
    const context = await browser.newContext();
    try {
      await context.addInitScript(installPageLoadObserver);
      const page = await context.newPage();
      const state = async (path: string) => {
        await page.goto(`${server.url.origin}${path}`);
        await page.waitForFunction(() => __pageLoad.state("web").ready !== null || __pageLoad.state("web").error !== null, undefined, { timeout: 10_000 });
        return page.evaluate(() => ({ ...__pageLoad.state("web"), markedAt: Reflect.get(globalThis, "markedAt") as number | undefined }));
      };
      const unmarked = await state("/unmarked");
      expect(unmarked.ready).toBeGreaterThan(0);
      expect(unmarked.error).toBeNull();
      const marked = await state("/marked");
      expect(marked.ready).toBe(marked.markedAt!);
      const failed = await state("/failed");
      expect(failed.ready).toBeNull();
      expect(failed.error).toBe("could not load bun.wasm");
    } finally {
      await context.close();
    }
  }
}, 60_000);
