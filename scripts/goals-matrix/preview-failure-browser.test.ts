import { expect, test } from "bun:test";
import { chromium, firefox, type Page } from "playwright";
import { createPageTransport } from "./transport";
import { withAdmission } from "./scope-fixture";

const observedEvents = ["pageerror", "console", "requestfailed", "response"] as const;
function listenerCount(page: Page, event: string): number {
  if (!("listenerCount" in page) || typeof page.listenerCount !== "function") throw new Error("Missing event listener counter");
  const count: unknown = page.listenerCount(event);
  if (typeof count !== "number") throw new Error("Invalid event listener count");
  return count;
}
function listeners(page: Page): number[] { return observedEvents.map(event => listenerCount(page, event)); }

for (const browserType of [chromium, firefox]) {
  test(`${browserType.name()} retains initiating preview failures and releases listeners`, async () => {
    let refusedURL = "";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/http-failure") return new Response("unavailable", { status: 503 });
      return new Response(`<!doctype html><title>Preview failure control</title><app-root></app-root><script>
        console.error('initiating console failure');
        queueMicrotask(() => { throw new Error('initiating page failure'); });
        globalThis.eventsReady = false;
        Promise.allSettled([fetch(${JSON.stringify(refusedURL)}), fetch('/http-failure')]).then(() => { globalThis.eventsReady = true; });
      </script>`, { headers: { "content-type": "text/html" } });
    } });
    let browser: Awaited<ReturnType<typeof browserType.launch>> | undefined;
    try {
      const refused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("unused"); } });
      refusedURL = new URL("network-failure", refused.url).href;
      await refused.stop(true);
      browser = await browserType.launch({ headless: true, timeout: 5000 });
      const context = await browser.newContext();
      const host = await context.newPage();
      const previews: { page: Page; before: number[] }[] = [];
      const transport = createPageTransport({ async newPage() {
        const page = await context.newPage();
        previews.push({ page, before: listeners(page) });
        return page;
      } }, host, {}, 5000, 5000, async () => {});
      await withAdmission(admission => transport.openPreview(server.url.href, admission));
      const first = previews[0];
      if (!first || !transport.previewFailure) throw new Error("Preview observation unavailable");
      const readPreview = transport.previewFailure.bind(transport);
      await first.page.waitForFunction("globalThis.eventsReady");
      expect(listeners(first.page)).toEqual(first.before.map(count => count + 1));
      const failure = await withAdmission(readPreview);
      expect(failure).toContain("initiating page failure");
      expect(failure).toContain("initiating console failure");
      expect(failure).toContain('"kind":"requestfailed"');
      expect(failure).toContain("/network-failure");
      expect(failure).toContain('"status":503');
      expect(failure).toContain('"readyState":"complete"');
      expect(failure).toContain('"message":null');
      await first.page.evaluate(() => { for (let index = 0; index < 40; index++) console.error("overflow control ".repeat(200)); });
      await first.page.waitForFunction("document.readyState === 'complete'");
      const bounded = await withAdmission(readPreview);
      expect((bounded.match(/"kind":/g) ?? []).length).toBe(32);
      expect(bounded).not.toContain('"dropped":0');
      expect(bounded.length).toBeLessThan(90_000);
      const evaluate = first.page.evaluate;
      first.page.evaluate = () => new Promise<never>(() => {});
      const started = performance.now();
      try {
        const stalled = await withAdmission(readPreview, 1000);
        expect(stalled).toContain("initiating page failure");
        expect(stalled).toContain("Preview DOM observation did not settle");
        expect(performance.now() - started).toBeLessThan(1000);
      } finally { first.page.evaluate = evaluate; }
      await withAdmission(admission => transport.closePreview(admission));
      expect(listeners(first.page)).toEqual(first.before);
      expect(await withAdmission(readPreview)).toBe("");
      await withAdmission(admission => transport.openPreview("data:text/html,<h1 id=message>success</h1>", admission));
      const success = previews[1];
      if (!success) throw new Error("Success preview missing");
      expect(await success.page.locator("#message").textContent()).toBe("success");
      await transport.close();
      expect(listeners(success.page)).toEqual(success.before);
      expect(await withAdmission(readPreview)).toBe("");
    } finally { await browser?.close(); await server.stop(true); }
  }, 30_000);
}
