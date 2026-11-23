import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, firefox, type Browser, type Page } from "playwright";
import { installPageLoadObserver, installStorageReadCounter, StorageReadObserver, type PageLoadState, type StorageRead } from "../sandbox/tests/page-load-support";

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

/**
 * A page script: stores a Waffle-shaped chunk manifest and chunk, reads them, walks them with a
 * cursor and digests with several algorithms, then returns what the counter recorded.
 */
async function exerciseStorage(): Promise<StorageRead[]> {
  const settled = (request: IDBRequest | IDBTransaction) => new Promise<void>((resolve, reject) => {
    if (request instanceof IDBTransaction) request.oncomplete = () => resolve();
    else request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const name = `bun-wasm-read-counter-${crypto.randomUUID()}`;
  const opened = indexedDB.open(name, 1);
  opened.onupgradeneeded = () => opened.result.createObjectStore("data");
  await settled(opened);
  const database = opened.result;
  const write = database.transaction("data", "readwrite");
  write.objectStore("data").put({ version: 2, size: 5, chunkSize: 65536, count: 1 }, "file");
  write.objectStore("data").put({ bytes: new Uint8Array(5), checksum: new Uint8Array(32) }, ["file", 0]);
  await settled(write);
  const read = database.transaction("data");
  read.objectStore("data").get("file");
  read.objectStore("data").get(["file", 0]);
  await settled(read);
  // Two rows: one entry each, and none for the cursor's final empty result.
  const walk = database.transaction("data");
  const cursor = walk.objectStore("data").openCursor();
  cursor.onsuccess = () => cursor.result?.continue();
  await settled(walk);
  await crypto.subtle.digest("SHA-256", new Uint8Array(5));
  await crypto.subtle.digest({ name: "sha-256" }, new Uint8Array(6));
  await crypto.subtle.digest("SHA-1", new Uint8Array(7));
  // A reused algorithm object changed after the call: digest() already used the original name.
  const reused = { name: "SHA-1" };
  const sha1 = crypto.subtle.digest(reused, new Uint8Array(8));
  reused.name = "SHA-256";
  await sha1;
  const changed = { name: "SHA-256" };
  const sha256 = crypto.subtle.digest(changed, new Uint8Array(9));
  changed.name = "SHA-1";
  await sha256;
  database.close();
  indexedDB.deleteDatabase(name);
  return __storageReads;
}

async function storageReads(browser: Browser): Promise<StorageRead[]> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.url.origin}/marked`);
    await page.evaluate(installStorageReadCounter);
    return await page.evaluate(exerciseStorage);
  } finally {
    await context.close();
  }
}

test("the storage read counter names each chunk manifest's file size, each chunk and cursor row, and only SHA-256 digests", async () => {
  for (const browser of browsers) {
    const reads = await storageReads(browser);
    expect(reads.map(({ kind, bytes, file, chunk }) => ({ kind, bytes, file, chunk }))).toEqual([
      { kind: "get", bytes: 0, file: 5, chunk: undefined },
      { kind: "get", bytes: 37, file: undefined, chunk: 0 },
      // Rows come in key order: the array key sorts after the string key.
      { kind: "cursor", bytes: 0, file: undefined, chunk: undefined },
      { kind: "cursor", bytes: 37, file: undefined, chunk: undefined },
      { kind: "sha256", bytes: 5, file: undefined, chunk: undefined },
      { kind: "sha256", bytes: 6, file: undefined, chunk: undefined },
      { kind: "sha256", bytes: 9, file: undefined, chunk: undefined },
    ]);
    for (const read of reads) expect(read.end).toBeGreaterThanOrEqual(read.start);
    // The second row's time starts at its continue() call, after the first row arrived.
    expect(reads[3]!.start).toBeGreaterThanOrEqual(reads[2]!.end);
  }
}, 60_000);

/** Reports its startup time, digests once at startup, then once more on each message. */
const countedWorker = `const startedAt = performance.timeOrigin + performance.now();
crypto.subtle.digest("SHA-256", new Uint8Array(1));
onmessage = async () => { await crypto.subtle.digest("SHA-256", new Uint8Array(2)); postMessage("digested"); };
postMessage(startedAt);`;
// A worker that never runs an evaluation cannot be built here: V8 serves inspector requests even
// during Atomics.wait. web/tests/page-load-profile.test.ts covers that case with a fake worker.
const workerScripts: Record<string, string> = {
  "/counted.js": countedWorker,
  "/closing.js": "postMessage('started'); close();",
};
const workerServer = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: request => {
    const script = workerScripts[new URL(request.url).pathname];
    if (script === undefined) return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    return new Response(script, { headers: { "content-type": "text/javascript" } });
  },
});
afterAll(() => workerServer.stop(true));

/** Starts both workers and waits until each has posted its first message. */
async function startWorkers(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const started = (worker: Worker) => new Promise<unknown>(resolve => { worker.onmessage = event => resolve(event.data); });
    const counted = new Worker("/counted.js");
    Reflect.set(globalThis, "counted", counted);
    const [startedAt] = await Promise.all([started(counted), started(new Worker("/closing.js"))]);
    return startedAt as number;
  });
}

/** A page script: asks the counted worker for one more digest and waits until it is done. */
function digestOnce(): Promise<void> {
  const counted = Reflect.get(globalThis, "counted") as Worker;
  const done = new Promise<void>(resolve => { counted.onmessage = () => resolve(); });
  counted.postMessage("digest");
  return done;
}

async function checkWorkerCoverage(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const observer = new StorageReadObserver();
    page.on("worker", worker => observer.watch(worker));
    await page.goto(`${workerServer.url.origin}/workers`);
    const startedAt = await startWorkers(page);
    // The counter lands after the worker started. Collecting waits for it; then digest again.
    const first = await observer.collect(5_000);
    expect(first.workers.find(worker => worker.url.endsWith("/counted.js"))?.status).toBe("observed");
    await page.evaluate(digestOnce);
    const { reads, workers } = await observer.collect(500);
    const byName = Object.fromEntries(workers.map(worker => [worker.url.split("/").pop(), worker]));
    expect(Object.keys(byName).toSorted()).toEqual(["closing.js", "counted.js"]);
    // Only the digest after installation counts; the startup digest predates the counter.
    expect(reads.map(({ kind, bytes }) => ({ kind, bytes }))).toEqual([{ kind: "sha256", bytes: 2 }]);
    expect(byName["counted.js"]).toMatchObject({ status: "observed", reads: 1 });
    expect(byName["counted.js"]!.installedAt).toBeGreaterThanOrEqual(startedAt);
    expect(byName["closing.js"]).toMatchObject({ status: "unavailable", reads: 0 });
  } finally {
    await context.close();
  }
}

test("workers whose reads are missing or start late are reported, not counted as idle", async () => {
  for (const browser of browsers) await checkWorkerCoverage(browser);
}, 60_000);
