import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { assertPreviewDocumentPreserved } from "../sandbox/tests/storage-document";
import { StorageLifetime, storageEvidence } from "./storage-browser-evidence";

const lifetimes: StorageLifetime[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) {
    await lifetime.cleanup();
    lifetime.assertClean();
  }
});

async function fixture(engine: BrowserType): Promise<Page> {
  const lifetime = storageEvidence(undefined);
  lifetimes.push(lifetime);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const body = new URL(request.url).pathname === "/" ? '<iframe id="preview" src="/preview"></iframe>' : "<h1>Source one</h1><button>count is 1</button>";
    return new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } });
  } });
  lifetime.own("server.close", () => server.stop(true));
  const { value: browser } = await lifetime.acquire("browser.launch", () => engine.launch({ headless: true }), browser => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(server.url.href);
  await page.frameLocator("#preview").getByRole("heading").waitFor();
  expect(lifetime.observation).toBeUndefined();
  return page;
}

async function replaceDocument(page: Page, mode: "reload" | "navigate" | "iframe"): Promise<void> {
  const loaded = page.waitForEvent("framenavigated", frame => frame !== page.mainFrame());
  await Promise.all([loaded, page.evaluate(mode => {
    const frame = document.querySelector("#preview");
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error("Missing preview");
    if (mode === "reload") return frame.contentWindow.location.reload();
    if (mode === "navigate") { frame.src = "/other"; return; }
    frame.outerHTML = '<iframe id="preview" src="/preview"></iframe>';
  }, mode)]);
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: preview Document survives source updates and synthetic timeOrigin precision drift`, async () => {
    const page = await fixture(engine);
    const body = page.frameLocator("#preview").locator("body");
    const native: number[] = [];
    await assertPreviewDocumentPreserved(page, async () => {
      for (let index = 0; index < 32; index++) native.push(await body.evaluate(() => performance.timeOrigin));
      await body.evaluate(() => {
        document.body.innerHTML = "<h1>Source two</h1><button>count is 1</button>";
        history.pushState({}, "", "#updated");
      });
    });
    console.log(JSON.stringify({ browser: engine.name(), control: "native same-document sampling", values: Array.from(new Set(native)) }));
    // Deliberate regression control using the recorded pair; this is not native drift evidence.
    await body.evaluate(() => Object.defineProperty(performance, "timeOrigin", { configurable: true, value: 1794662261350.74 }));
    const before = await body.evaluate(() => performance.timeOrigin);
    let after = before;
    await assertPreviewDocumentPreserved(page, async () => {
      await body.evaluate(() => {
        document.body.innerHTML = "<h1>Source three</h1><button>count is 1</button>";
        Object.defineProperty(performance, "timeOrigin", { configurable: true, value: 1794662261350.72 });
      });
      after = await body.evaluate(() => performance.timeOrigin);
    });
    expect(() => assert.equal(after, before)).toThrow();
    expect(await body.textContent()).toContain("Source three");
    expect(await body.textContent()).toContain("count is 1");
    console.log(JSON.stringify({ browser: engine.name(), control: "synthetic recorded precision drift", before, after, numericCheck: "refused", documentCheck: "preserved" }));
  }, 30_000);

  test(`${engine.name()}: preview Document check refuses real reload, navigation and iframe replacement`, async () => {
    const page = await fixture(engine);
    for (const mode of ["reload", "navigate", "iframe"] as const) {
      await expect(assertPreviewDocumentPreserved(page, () => replaceDocument(page, mode))).rejects.toThrow("restored source HMR replaced the document");
    }
  }, 30_000);

  test(`${engine.name()}: Document handles are released after update, identity and evidence failures`, async () => {
    const page = await fixture(engine);
    for (const mode of ["update", "identity", "evidence"] as const) await releaseOnFailure(page, mode);
  }, 30_000);
}

async function releaseOnFailure(page: Page, mode: "update" | "identity" | "evidence"): Promise<void> {
  const closed: string[] = [];
  const lifetime = new StorageLifetime(event => {
    if (event.kind === "cleanup-end") closed.push(JSON.stringify(event.detail));
    if (mode === "evidence" && event.kind === "end") throw new Error("evidence write control");
  });
  lifetimes.push(lifetime);
  const update = async () => {
    if (mode === "update") throw new Error("update control");
    await replaceDocument(page, "reload");
  };
  const failure = mode === "update" ? "update control" : mode === "identity" ? "restored source HMR replaced the document" : "evidence write control";
  await expect(lifetime.run(() => assertPreviewDocumentPreserved(page, update, lifetime.observation))).rejects.toThrow(failure);
  await lifetime.cleanup();
  expect(closed).toEqual([JSON.stringify({ phase: "vanilla.document-before-hmr.close" })]);
  if (mode === "evidence") expect(lifetime.failures).toHaveLength(1);
  // The evidence failure is intentional; afterEach still checks all real cleanup failures.
  if (mode === "evidence") lifetime.failures.splice(0);
  lifetime.assertClean();
}
