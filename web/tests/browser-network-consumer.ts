import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt";

const names = process.argv.slice(2);
assert.ok(names.length > 0 && names.every(name => ["chromium", "firefox", "webkit"].includes(name)), "explicit known browsers required");
const artifactInput = process.env.NETWORK_CONSUMER_GUEST;
assert.ok(artifactInput && isAbsolute(artifactInput), "NETWORK_CONSUMER_GUEST must be an absolute borrowed artifact path");
const artifact = await realpath(artifactInput);
const guest = new Uint8Array(await Bun.file(artifact).arrayBuffer());
const receipt: unknown = await Bun.file(`${artifact}.build.json`).json();
verifyGuestBuildReceipt(guest, receipt);
const expectedInputs = process.env.NETWORK_CONSUMER_EXPECTED_INPUTS;
assert.ok(expectedInputs && isAbsolute(expectedInputs), "NETWORK_CONSUMER_EXPECTED_INPUTS must be an absolute accepted build inputs JSON path");
const accepted: unknown = await Bun.file(expectedInputs).json();
assert.ok(accepted && typeof accepted === "object", "accepted build inputs must be an object");
for (const field of ["bunHead", "bunTree", "sysrootReceiptSha256"] as const) {
  assert.equal(receipt[field], Reflect.get(accepted, field), `guest build receipt matches accepted ${field}`);
}
const artifactReceipt = { path: artifact, receipt, expectedInputs };
if (process.env.NETWORK_CONSUMER_PREFLIGHT_ONLY === "1") {
  console.log(JSON.stringify({ ready: true, artifact: artifactReceipt, acceptance: "pending browser execution" }));
  process.exit(0);
}
const port = Number(process.env.NETWORK_CONSUMER_PORT ?? 43829);
assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535, "explicit free listener port required");
let scratch: string | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally { server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("consumer browser deadline"); void cleanup().finally(() => process.exit(1)); }, 600_000);
const echoSocket = () => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(location.origin.replace("http", "ws") + "/socket");
      const timer = setTimeout(() => { ws.close(); reject(new Error("child socket deadline")); }, 15_000);
      ws.onopen = () => ws.send("child socket");
      ws.onmessage = event => { clearTimeout(timer); ws.close(); resolve(String(event.data)); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("child socket failed")); };
    });
const cancelStream = async () => {
      const controller = new AbortController();
      const response = await fetch("/stream", { signal: controller.signal });
      const reader = response.body!.getReader();
      await new Promise(resolve => setTimeout(resolve, 100));
      const first = await reader.read();
      await reader.cancel(); controller.abort();
      return { status: response.status, chunk: first.value?.byteLength };
    };
async function verifyIsolation(context: BrowserContext, page: Page) {
  const other = await context.newPage();
  try {
    await other.goto(`http://127.0.0.1:${port}/`);
    await other.waitForFunction(() => Reflect.has(globalThis, "networkConsumer"));
    const isolated = await other.evaluate(() => Reflect.get(globalThis, "networkConsumer").isolated());
    assert.deepEqual(isolated, { port: 31972, listening: true });
    const stopped = await other.evaluate(() => Reflect.get(globalThis, "networkConsumer").cleanup());
    assert.deepEqual({ workers: stopped.workers, listeners: stopped.listeners }, { workers: 0, listeners: 0 });
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "networkConsumer").survivor()), true);
  } finally { await other.close(); }
}
async function exercise(name: string, mode: "prepare" | "publicAdapter") {
  if (!browser) throw new Error("browser not launched");
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => Reflect.has(globalThis, "networkConsumer"));
    const result = await page.evaluate(mode => Reflect.get(globalThis, "networkConsumer")[mode](), mode);
    if (mode === "prepare") await verifyIsolation(context, page);
    const preview = await context.newPage();
    const url = `http://127.0.0.1:${port}/__preview/31972/`;
    const response = await preview.goto(url);
    assert.ok(response, "preview navigation response");
    assert.ok(response.fromServiceWorker(), "child request goes through actual preview service worker");
    assert.equal(response.status(), 200);
    assert.equal(await preview.locator("body").innerText(), "server-31972");
    const socket = await preview.evaluate(echoSocket);
    assert.equal(socket, "child socket");
    const stream = await preview.evaluate(cancelStream);
    assert.equal(stream.status, 200);
    assert.ok(stream.chunk! > 0, "paused response still streams before cancellation");
    const released = await page.evaluate(() => Reflect.get(globalThis, "networkConsumer").cleanup());
    assert.deepEqual({ workers: released.workers, listeners: released.listeners }, { workers: 0, listeners: 0 });
    assert.deepEqual(errors, [], "no browser diagnostics");
    console.log(JSON.stringify({ browser: name, mode, result, serviceWorker: true, socket, stream, cleanup: released, errors }));
  } catch (error) {
    console.error(JSON.stringify({ browser: name, mode, diagnostics: await page.evaluate(() => Reflect.get(globalThis, "networkConsumer")?.diagnostics()), errors }));
    throw error;
  } finally { await context.close(); }
}
try {
  const { chromium, firefox, webkit } = await import("playwright");
  const { buildBrowserEntries, buildClassicWorker } = await import("../../scripts/browser-build");
  const { previewWebsocketScript } = await import("../preview-build");
  const types = { chromium, firefox, webkit };
  const base = process.env.NETWORK_CONSUMER_SCRATCH ?? process.env.SCRATCH ?? tmpdir();
  scratch = await mkdtemp(join(base, "network-consumer-"));
  console.log(JSON.stringify({ resources: { existing: { artifact: artifactReceipt, browsers: "borrowed cache" }, created: { scratch, port, browsers: names } } }));
  const out = join(scratch, "dist");
  const root = resolve(import.meta.dir, "../..");
  const entry = join(import.meta.dir, "browser-network-consumer-main.ts");
  await buildBrowserEntries([entry, join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts")], out, { runtimeWorker: true });
  await buildClassicWorker(join(root, "web/src/sw.ts"), out, { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(await previewWebsocketScript()) }, entry);
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./browser-network-consumer-main.js"></script>');
  server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    if (pathname === "/bun-guest.wasm") return new Response(guest, { headers: { ...headers, "Content-Type": "application/wasm" } });
    const path = resolve(out, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(out + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  for (const name of names) {
    const type = types[name as keyof typeof types];
    assert.ok(existsSync(type.executablePath()), `cached ${name} required`);
    launching = type.launch({ headless: true }); browser = await launching;
    await exercise(name, "prepare"); await exercise(name, "publicAdapter");
    await browser.close(); browser = undefined; launching = undefined;
  }
} finally {
  clearTimeout(deadline); await cleanup();
  assert.equal(scratch ? existsSync(scratch) : false, false, "owned source bundles removed");
  const listening = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false);
  assert.equal(listening, false, "owned HTTP port released");
  assert.equal(await Bun.file(artifact).exists(), true, "borrowed guest preserved");
  console.log(JSON.stringify({ cleanup: { scratchRemoved: true, browserClosed: true, listenerStopped: true, artifactPreserved: true } }));
}
