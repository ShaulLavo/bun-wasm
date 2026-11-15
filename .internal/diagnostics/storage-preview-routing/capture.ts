import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { webkit, type BrowserContext, type Page, type Response as BrowserResponse } from "../../../node_modules/playwright/index";
import { preservationScenario, openTemplate } from "../../../sandbox/tests/storage-browser.ts";
import { StorageLifetime, type StorageObservation } from "../../../scripts/storage-browser-evidence.ts";
import { verifySite } from "../../../scripts/browser-guest-site.ts";
import { verifyBrowserProgram } from "../../../scripts/ci-browser-program.ts";
import { qualify, record, rows, type Row } from "./qualification";
import { root, evidence, original, staged, repo, packet, source } from "./paths";

assert.equal(process.env.GITHUB_ACTIONS, "true", "actual app capture is hosted only");
const mode = process.argv[2]; assert(mode === "qualify" || mode === "scenario");
const output = join(evidence, mode); await mkdir(output, { recursive: true });
const before = verifySite(original);
const build = await Bun.file(join(evidence, "BUILD.json")).json();
const started = Date.now();
const write = (name: string, value: unknown) => Bun.write(join(output, name), JSON.stringify(value, null, 2));
const line = (name: string, value: unknown) => appendFileSync(join(output, name), JSON.stringify(value) + "\n");
const lifetime = new StorageLifetime(value => line("progress.jsonl", value));
const stream: Row[] = [];
const pending = new Set<Promise<unknown>>();
const contexts = new Set<BrowserContext>();
let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleanupTask: Promise<void> | undefined;
const temporary = join(root, "webkit-" + mode);
function retain(batch: unknown) {
  for (const entry of rows(batch)) {
    line("raw-routing.jsonl", entry);
    assert(record(entry.value));
    stream.push({ ...entry, ...entry.value });
  }
}
function background(task: Promise<unknown>) {
  pending.add(task);
  void task.catch(error => line("secondary-errors.jsonl", { error: String(error) })).finally(() => pending.delete(task));
}
async function response(page: Page, value: BrowserResponse) {
  const request = value.request();
  if (request.resourceType() !== "document") return;
  let body: string | null = null;
  let bodyError: string | null = null;
  try { body = await value.text(); } catch (error) { bodyError = String(error); }
  line("document-responses.jsonl", { page: page.url(), url: value.url(), status: value.status(), headers: await value.allHeaders(), fromServiceWorker: value.fromServiceWorker(), body, bodyError });
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const journal = Reflect.get(globalThis, "__routingJournal");
    if (!journal) return { url: location.href, unavailable: true };
    await journal.drain();
    const local = journal.snapshot();
    const app = Reflect.get(globalThis, "sandbox");
    const identity = Reflect.get(globalThis, "__routingState");
    const registrations = await navigator.serviceWorker.getRegistrations();
    const workers = await Promise.all(registrations.map(async registration => {
      const worker = registration.active;
      const actual = { scope: registration.scope, activeURL: worker?.scriptURL, state: worker?.state };
      if (!worker) return actual;
      const channel = new MessageChannel();
      try {
        const value = await new Promise<unknown>((resolve, reject) => {
          const cap = setTimeout(() => reject(new Error("diagnostic generation snapshot hang")), 15000);
          channel.port1.onmessage = event => { clearTimeout(cap); resolve(event.data); };
          worker.postMessage({ type: "storage-routing-diagnostic-snapshot" }, [channel.port2]);
        });
        return { ...actual, evaluated: value };
      } catch (error) { return { ...actual, error: String(error) }; }
      finally { channel.port1.close(); channel.port2.close(); }
    }));
    return { ...local, runtimeId: app ? identity?.ids.get(app.runtime) : null, template: app?.template, mainDocument: window === window.top, workers };
  });
}
async function closing(context: BrowserContext) {
  try {
    const values = await Promise.all(context.pages().map(page => snapshot(page).catch(error => ({ error: String(error) }))));
    await write(`closing-${contexts.size}.json`, values);
  } finally { contexts.delete(context); await context.close(); }
}
async function arm(context: BrowserContext) {
  await context.exposeBinding("__storageRoutingRecord", ({ page, frame }, text: string) => {
    const value: unknown = JSON.parse(text);
    retain([value]);
    line("binding-sources.jsonl", { url: page.url(), frame: frame.url(), main: frame === page.mainFrame() });
  });
}
function observe(context: BrowserContext) {
  contexts.add(context); lifetime.observeContext(context);
  context.on("page", page => page.on("response", value => background(response(page, value))));
}
const observation: StorageObservation = {
  step: lifetime.step.bind(lifetime), event: lifetime.event.bind(lifetime), own: lifetime.own.bind(lifetime), secondary: lifetime.secondary.bind(lifetime), observeContext: observe,
  acquire: async (phase, open, close) => {
    const acquired = await lifetime.acquire(phase, open, async value => {
    // This original caller phase acquires exactly a BrowserContext.
    if (phase === "context.create") await closing(value as BrowserContext);
    else await close(value);
    });
    try {
      if (phase === "context.create") await arm(acquired.value as BrowserContext);
      return acquired;
    } catch (error) { await acquired.release(); throw error; }
  },
};
async function serveEvidence(request: Request) {
  retain(await request.json());
  return new Response(null, { status: 204 });
}
async function servedSW(request: Request, response: globalThis.Response) {
  const bytes = await response.clone().arrayBuffer();
  const sha256 = Bun.SHA256.hash(bytes, "hex");
  line("actually-served-sw.jsonl", { url: request.url, status: response.status, headers: Array.from(response.headers), sha256, bytes: bytes.byteLength, build: build.build });
  await Bun.write(join(output, `served-sw-${sha256}.js.gz`), Bun.gzipSync(new Uint8Array(bytes)));
}
function interceptServe(options: Parameters<typeof Bun.serve>[0]) {
  const originalFetch = options.fetch; assert(typeof originalFetch === "function");
  const fetch: typeof originalFetch = async function(...args) {
    const path = new URL(args[0].url).pathname;
    if (path === "/__storage-routing-evidence" && args[0].method === "POST") return serveEvidence(args[0]);
    const result = await Reflect.apply(originalFetch, this, args);
    if (path.endsWith("/sw.js") && result instanceof Response) await servedSW(args[0], result);
    return result;
  };
  return { ...options, fetch };
}
async function startServer() {
  process.env.ROOT = staged; process.env.PORT = "0"; process.env.HOST = "127.0.0.1";
  const originalServe = Bun.serve;
  Bun.serve = function(options) { const created = Reflect.apply(originalServe, Bun, [interceptServe(options)]); server = created; return created; };
  try { await import(join(repo, "web/serve.ts")); } finally { Bun.serve = originalServe; }
  assert(server);
}
async function qualification(base: string) {
  assert(browser);
  const context = await browser.newContext();
  try {
    await arm(context);
    observe(context);
    const page = await context.newPage();
    await openTemplate(page, base, "hono", observation);
    const url = await page.locator("#preview").getAttribute("src"); assert(url);
    const target = "/?__storageRoutingQualification=" + crypto.randomUUID();
    const probeURL = new URL(url, base); probeURL.search = new URL(target, base).search;
    const probe = await context.newPage();
    const reply = await probe.goto(probeURL.href, { timeout: 180000 }); assert(reply);
    const native = { url: reply.url(), status: reply.status(), headers: await reply.allHeaders(), body: await reply.text(), fromServiceWorker: reply.fromServiceWorker() };
    const raw = await snapshot(page);
    await write("positive-raw.json", { raw, response: native, stream });
    assert(record(raw) && Array.isArray(raw.workers));
    const registration = raw.workers.find(item => record(item) && typeof item.scope === "string" && item.scope.endsWith("/sandbox/__preview/"));
    assert(record(registration) && record(registration.evaluated));
    const worker = registration.evaluated;
    assert(Array.isArray(worker.rows));
    const combined = stream.concat(rows(raw.rows).concat(rows(worker.rows)).map(entry => ({ ...entry, ...recordValue(entry.value) })));
    const unique = new Map(combined.map(row => [String(row.generation) + ":" + String(row.journalSequence), row]));
    const result = qualify({ rows: Array.from(unique.values()), target, url: probeURL.href, build: build.build, worker, page: raw, response: native });
    assert.equal(Array.isArray(worker.failures) ? worker.failures.length : null, 0); assert.equal(Array.isArray(raw.failures) ? raw.failures.length : null, 0);
    const served = await Bun.file(join(output, "actually-served-sw.jsonl")).text();
    assert(served.includes(build.sw.instrumentedSha256));
    await write("QUALIFIED.json", { ...result, registration, originalHono: true, mockedHelper: false });
  } finally { await closing(context); }
}
function recordValue(value: unknown): Row { assert(record(value)); return value; }
async function cleanup() {
  return cleanupTask ??= lifetime.cleanup().finally(async () => {
    try { await Promise.all(Array.from(contexts, context => closing(context))); }
    finally { await closeBrowserAndServer(); }
  });
}
async function closeBrowserAndServer() {
  try { await browser?.close(); await Promise.allSettled(Array.from(pending)); }
  finally { await server?.stop(true); await rm(temporary, { recursive: true, force: true }); }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(1)));
const hang = setTimeout(() => void cleanup().finally(() => process.exit(124)), mode === "qualify" ? 600000 : 1800000);
try {
  await mkdir(temporary); process.env.TMPDIR = temporary;
  await startServer(); assert(server);
  await write("resources.json", { pid: process.pid, port: server.port, temporary, staged, executable: webkit.executablePath() });
  const acquired = await lifetime.acquire("browser.launch", () => webkit.launch({ headless: true }), value => value.close());
  try {
    browser = acquired.value; lifetime.observeBrowser(browser);
    const base = `http://127.0.0.1:${server.port}/sandbox/`;
    if (mode === "qualify") await qualification(base);
    else {
      const gate = await Bun.file(join(evidence, "qualify/QUALIFIED.json")).json();
      assert(gate.armed && gate.build === build.build && gate.originalHono && gate.mockedHelper === false);
      await preservationScenario(browser, base, observation);
    }
    await write("OUTCOME.json", { outcome: "passed", mode, diagnosticOnly: true, durationMs: Date.now() - started });
  } finally { await acquired.release(); }
} catch (error) {
  await write("OUTCOME.json", { outcome: "failed", mode, error: String(error), stack: error instanceof Error ? error.stack : null,
    originalReport: record(error) && "report" in error ? error.report : null, diagnosticOnly: true, durationMs: Date.now() - started });
  throw error;
} finally {
  clearTimeout(hang);
  try { await cleanup(); }
  finally {
    assert.deepEqual(verifySite(original), before);
    await verifyBrowserProgram(packet, source);
    execFileSync(process.execPath, [join(repo, "scripts/ci-browser-program.ts"), "verify", packet], { cwd: repo, stdio: "inherit" });
    assert.equal(execFileSync("git", ["diff", "--exit-code"], { cwd: repo, encoding: "utf8" }), "");
    execFileSync(process.execPath, [join(repo, "scripts/browser-guest-site.ts"), "verify", original], { cwd: repo, stdio: "inherit" });
    const port = server?.port;
    const listening = port ? await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false) : false;
    await write("CLEANUP.json", { port, listenerStopped: !listening, browserClosed: !browser?.isConnected(), temporaryRemoved: !existsSync(temporary), originalSiteVerifierAfter: true });
    assert(!listening); assert(!existsSync(temporary));
  }
}
