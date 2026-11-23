import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, firefox, type Browser, type Page } from "playwright";
import { installPageLoadObserver, installStorageReadCounter, type PageLoadState, type StorageRead } from "../sandbox/tests/page-load-support";

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
    // Each browser is registered as soon as it launches, so a failing second launch still closes the first.
    browsers.push(await chromium.launch({ headless: true }));
    browsers.push(await firefox.launch({ headless: true }));
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

/** The observer's settled state for one fixture page. */
async function observed(page: Page, path: string): Promise<PageLoadState & { markedAt?: number }> {
  await page.goto(`${server.url.origin}${path}`);
  await page.waitForFunction(() => __pageLoad.state("web").ready !== null || __pageLoad.state("web").error !== null, undefined, { timeout: 10_000 });
  return page.evaluate(() => ({ ...__pageLoad.state("web"), markedAt: Reflect.get(globalThis, "markedAt") as number | undefined }));
}

async function checkReadiness(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    await context.addInitScript(installPageLoadObserver);
    const page = await context.newPage();
    const unmarked = await observed(page, "/unmarked");
    expect(unmarked.ready).toBeGreaterThan(0);
    expect(unmarked.error).toBeNull();
    const marked = await observed(page, "/marked");
    expect(marked.ready).toBe(marked.markedAt!);
    const failed = await observed(page, "/failed");
    expect(failed.ready).toBeNull();
    expect(failed.error).toBe("could not load bun.wasm");
  } finally {
    await context.close();
  }
}

test("page readiness comes from the page's marks, or from #status on builds without them", async () => {
  for (const browser of browsers) await checkReadiness(browser);
}, 60_000);

declare const __storageReads: StorageRead[];

/** Stores a Waffle-shaped chunk manifest and chunk, then reads and digests them once. */
async function storageReads(browser: Browser): Promise<StorageRead[]> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.url.origin}/marked`);
    await page.evaluate(installStorageReadCounter);
    return await page.evaluate(async () => {
      const name = `bun-wasm-read-counter-${crypto.randomUUID()}`;
      const opened = indexedDB.open(name, 1);
      opened.onupgradeneeded = () => opened.result.createObjectStore("data");
      const database = await new Promise<IDBDatabase>((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
      const settled = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
      const write = database.transaction("data", "readwrite");
      write.objectStore("data").put({ version: 2, size: 5, chunkSize: 65536, count: 1 }, "file");
      write.objectStore("data").put({ bytes: new Uint8Array(5), checksum: new Uint8Array(32) }, ["file", 0]);
      await settled(write);
      const read = database.transaction("data");
      read.objectStore("data").get("file");
      read.objectStore("data").get(["file", 0]);
      await settled(read);
      await crypto.subtle.digest("SHA-256", new Uint8Array(5));
      database.close();
      indexedDB.deleteDatabase(name);
      return __storageReads;
    });
  } finally {
    await context.close();
  }
}

test("the storage read counter names each chunk manifest's file size and each chunk read", async () => {
  for (const browser of browsers) {
    const reads = await storageReads(browser);
    expect(reads.map(({ kind, bytes, file, chunk }) => ({ kind, bytes, file, chunk }))).toEqual([
      { kind: "get", bytes: 0, file: 5, chunk: undefined },
      { kind: "get", bytes: 37, file: undefined, chunk: 0 },
      { kind: "digest", bytes: 5, file: undefined, chunk: undefined },
    ]);
    for (const read of reads) expect(read.end).toBeGreaterThanOrEqual(read.start);
  }
}, 60_000);
