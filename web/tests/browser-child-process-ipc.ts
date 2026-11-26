// Build web/ with BUN_BROWSER_WASM=<guest>, then run through the PC browser queue.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import { ready, terminalText, writeFile } from "./playground.mjs";
import { runForeground, stopForeground } from "./foreground";
import { ipcChild, ipcParent } from "./child-process-ipc-fixtures";

const before = process.argv.includes("--before");
const port = Number(process.env.IPC_BROWSER_PORT ?? 4197);
const guestPort = 31783;
const root = resolve(import.meta.dir, "../dist");
const originalTmp = process.env.TMPDIR;
let scratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
async function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      if (scratch) await rm(scratch, { recursive: true, force: true });
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 180_000);
try {
  assert.ok(existsSync(chromium.executablePath()), "cached Chromium required");
  scratch = await mkdtemp("/work/tmp/bw-ipc-");
  process.env.TMPDIR = scratch;
  console.log(JSON.stringify({ resources: { existing: "installed packages, browser cache and caller-built web/dist", created: { scratch, port, guestPort, browser: "headless Chromium and profile" } } }));
  server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const path = resolve(root, "." + (new URL(request.url).pathname === "/" ? "/index.html" : new URL(request.url).pathname));
    if (!path.startsWith(root + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404 });
    return new Response(Bun.file(path), { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" } });
  } });
  launching = chromium.launch({ headless: true });
  browser = await launching;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    // Only workers the page has sent a request count: Waffle prestarts idle process workers.
    const active = new Set<Worker>();
    let created = 0;
    let peak = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); created++;
      }
      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        active.add(this); peak = Math.max(peak, active.size);
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
      override terminate() { active.delete(this); super.terminate(); }
    };
    Reflect.set(globalThis, "ipcWorkerCounts", () => ({ active: active.size, created, peak }));
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?engine=browser&wasm=/bun-browser.wasm.gz`);
  await ready(page);
  const workersBefore = await page.evaluate(() => Reflect.get(globalThis, "ipcWorkerCounts")());
  const token = crypto.randomUUID();
  await writeFile(page, "/home/user/ipc-child.ts", ipcChild);
  await writeFile(page, "/home/user/ipc-idle.ts", 'const removed = () => {}; process.on("message", removed); process.removeListener("message", removed); process.send({ idle: true });');
  await writeFile(page, "/home/user/ipc-self.ts", 'process.send({selfDisconnected:true}); process.disconnect(); if (process.connected) throw Error("child connected after disconnect");');
  await writeFile(page, "/home/user/ipc-parent.ts", ipcParent(token, guestPort));
  const execution = runForeground(page, "bun /home/user/ipc-parent.ts", 90_000);
  if (before) {
    const outcome = await execution;
    const terminal = await terminalText(page);
    console.log(JSON.stringify({ before, outcome, terminal }));
    assert.notEqual(outcome.code, 0, "baseline must reject missing IPC");
    assert.match(terminal, /implicit fork channel|Child process IPC|child close/);
  } else {
    try {
      await page.waitForFunction(() => {
        const term = Reflect.get(globalThis, "playground").term;
        const buffer = term.buffer.active;
        return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n").includes("ipc-preview-ready");
      }, undefined, { timeout: 90_000 });
      await page.waitForFunction(
        async (targetPort: number) => {
          const pg = Reflect.get(globalThis, "playground");
          return (await pg.previews.ready) === "ready" && Boolean(pg.previews.serves(targetPort));
        },
        guestPort,
        { timeout: 15_000 },
      );
      const preview = await page.evaluate(
        (targetPort: number) => Reflect.get(globalThis, "playground").previews.url(targetPort) as string,
        guestPort,
      );
      // Terminal prints `[preview] localhost:<port>` only after waitUntilRegistered + isListenerReady.
      await page.waitForFunction(
        (expected: string) => {
          const term = Reflect.get(globalThis, "playground").term;
          const buffer = term.buffer.active;
          return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n").includes(expected);
        },
        `[preview] localhost:${guestPort}`,
        { timeout: 15_000 },
      );
      const expectedReport = {
        token,
        exchanges: [
          { id: "a", ready: true, replies: 12, callbacks: 12, disconnected: 1, closedError: "ERR_IPC_CHANNEL_CLOSED" },
          { id: "b", ready: true, replies: 12, callbacks: 12, disconnected: 1, closedError: "ERR_IPC_CHANNEL_CLOSED" },
        ],
        exitBurst: { received: 257, last: 256, callbacks: 257, disconnected: 1, connected: false },
        bye: 73,
        idleExited: true,
        advancedRejected: true,
        selfMessage: true,
        selfDisconnects: 1,
        bunReply: token,
      };
      const previewPage = await page.context().newPage();
      const deliveredResponse = previewPage.waitForResponse(
        res => res.url() === preview && res.request().isNavigationRequest() && res.status() !== 302,
        { timeout: 30_000 },
      );
      await previewPage.goto(preview, { waitUntil: "domcontentloaded" });
      const response = await deliveredResponse;
      await previewPage.waitForURL(preview, { timeout: 30_000 });
      const navText = await response.text();
      console.log(JSON.stringify({ previewNavigation: { url: response.url(), status: response.status(), serviceWorker: response.fromServiceWorker(), headers: response.headers(), body: navText } }));
      assert.equal(response.status(), 200);
      assert.equal(response.fromServiceWorker(), true, "actual service-worker preview request");
      assert.deepEqual(JSON.parse(navText), expectedReport);
      const result = await previewPage.evaluate(async () => {
        const res = await fetch(location.href);
        const text = await res.text();
        return { status: res.status, text, report: JSON.parse(text) };
      });
      Object.assign(result, { serviceWorker: response.fromServiceWorker() });
      console.log(JSON.stringify({ browser: browser.version(), preview, result, errors }));
      assert.equal(result.status, 200);
      assert.deepEqual(result.report, expectedReport);
      await page.waitForFunction(initial => Reflect.get(globalThis, "ipcWorkerCounts")().active === initial + 1, workersBefore.active, { timeout: 15_000 });
      console.log(JSON.stringify({ childrenReapedWhileParentLive: await page.evaluate(() => Reflect.get(globalThis, "ipcWorkerCounts")()) }));
      assert.deepEqual(errors, []);
      await previewPage.evaluate(url => fetch(new URL("stop", url).href).then(response => response.text()), preview);
      await previewPage.close();
      assert.equal((await execution).code, 0);
    } catch (error) {
      console.error(await terminalText(page));
      await stopForeground(page);
      throw error;
    }
  }
  await page.waitForFunction(initial => Reflect.get(globalThis, "ipcWorkerCounts")().active === initial, workersBefore.active, { timeout: 15_000 });
  const workersAfter = await page.evaluate(() => Reflect.get(globalThis, "ipcWorkerCounts")());
  console.log(JSON.stringify({ workerCleanup: { before: workersBefore, after: workersAfter } }));
  if (!before) assert.ok(workersAfter.peak >= workersBefore.active + 3, "two children ran simultaneously under the root");
} finally {
  clearTimeout(deadline);
  await cleanup();
  assert.equal(scratch ? existsSync(scratch) : false, false, "browser scratch removed");
  const listening = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false);
  assert.equal(listening, false, "owned listener stopped");
  console.log(JSON.stringify({ cleanup: { scratchRemoved: true, listenerStopped: true, browserClosed: true } }));
}
