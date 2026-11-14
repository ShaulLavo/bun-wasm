import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { firefox, type BrowserContext, type Page } from "../../../node_modules/playwright/index";
import { preservationScenario } from "../../../sandbox/tests/storage-browser.ts";
import { StorageLifetime, type StorageObservation } from "../../../scripts/storage-browser-evidence.ts";
import { verifySite } from "../../../scripts/browser-guest-site.ts";
import { qualify } from "./qualify.ts";
import { endpointIdentity, sameConnection } from "./endpoint-identity.ts";
import { root, evidence, original, staged, repo } from "./paths.ts";

const mode = process.argv[2];
assert(mode === "qualify" || mode === "scenario");
if (mode === "scenario") assert(process.env.GITHUB_ACTIONS === "true", "full scenario is hosted only");
const output = join(evidence, process.env.SF_CAPTURE_LABEL ?? mode);
await mkdir(output, { recursive: true });
const before = verifySite(original);
const started = Date.now();
const write = (name: string, value: unknown) => Bun.write(join(output, name), JSON.stringify(value, null, 2));
const line = (name: string, value: unknown) => appendFileSync(join(output, name), JSON.stringify(value) + "\n");
const lifetime = new StorageLifetime(event => line("progress.jsonl", event));
let browser: Awaited<ReturnType<typeof firefox.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let port: number | undefined;
let contextCount = 0;
let cleanupTask: Promise<void> | undefined;
const temporary = join(root, "firefox-" + mode);
const bindingPages = new WeakMap<Page, number>();
let nextBindingPage = 0;
async function arm(context: BrowserContext) {
  await context.exposeBinding("storageEndpointRecord", ({ page, frame }, value) => {
    if (!bindingPages.has(page)) bindingPages.set(page, ++nextBindingPage);
    line("raw-endpoints.jsonl", value);
    line("binding-sources.jsonl", { page: bindingPages.get(page), main: frame === page.mainFrame(), capture: value?.capture, sequence: value?.collectorSequence });
  });
}
async function cleanup() {
  return cleanupTask ??= lifetime.cleanup().finally(async () => {
    try { await browser?.close(); }
    finally { server?.stop(true); await rm(temporary, { recursive: true, force: true }); }
  });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(1)));
const hang = setTimeout(() => void cleanup().finally(() => process.exit(124)), mode === "qualify" ? 600000 : 1800000);

function observe(context: BrowserContext) {
  lifetime.observeContext(context);
  context.on("page", page => {
    page.on("response", response => line("responses.jsonl", { page: page.url(), url: response.url(), status: response.status(), serviceWorker: response.fromServiceWorker() }));
    page.on("framenavigated", frame => line("frames.jsonl", { page: page.url(), url: frame.url(), main: frame === page.mainFrame() }));
  });
}
async function raw(page: Page) {
  await page.evaluate(async () => { const observer = Reflect.get(globalThis, "sandboxObserver"); await observer.snapshotServices(); await observer.drain(); });
  return page.evaluate(() => Reflect.get(globalThis, "sandboxObserver").snapshot());
}
async function closing(context: BrowserContext) {
  try {
    const pages = await Promise.all(context.pages().map(async (page, index) => {
      const value = await raw(page).catch(error => ({ error: String(error), url: page.url() }));
      await write(`context-${contextCount}-page-${index}-closing-raw.json`, value);
      return value;
    }));
    await write(`context-${contextCount}-closing.json`, pages);
  } finally { await context.close(); }
}
const observation: StorageObservation = {
  step: lifetime.step.bind(lifetime), event: lifetime.event.bind(lifetime), own: lifetime.own.bind(lifetime), secondary: lifetime.secondary.bind(lifetime),
  observeContext: observe,
  acquire: async (phase, open, close) => {
    const acquired = await lifetime.acquire(phase, open, async value => {
      if (phase === "context.create") await closing(value as BrowserContext);
      else await close(value);
    });
    if (phase === "context.create") await arm(acquired.value as BrowserContext);
    return acquired;
  },
};
async function diagnosticRequest(request: Request) {
  const url = new URL(request.url);
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  if (url.pathname === "/evidence" && request.method === "POST") {
    line("raw-endpoints.jsonl", await request.json());
    return new Response(null, { status: 204, headers });
  }
  if (url.pathname === "/gate" && request.method === "POST") return gate(request, headers);
  return new Response(null, { status: 404, headers });
}
async function startServer() {
  process.env.ROOT = staged;
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  const originalServe = Bun.serve;
  Bun.serve = function (options) {
    const originalFetch = options.fetch;
    assert(typeof originalFetch === "function");
    const fetch: typeof originalFetch = function (...args) {
      const path = new URL(args[0].url).pathname;
      if (path === "/evidence" || path === "/gate") return diagnosticRequest(args[0]);
      return Reflect.apply(originalFetch, this, args);
    };
    const created = Reflect.apply(originalServe, Bun, [{ ...options, fetch }]);
    server = created;
    return created;
  };
  try { await import(join(repo, "web/serve.ts")); }
  finally { Bun.serve = originalServe; }
  assert(server);
  await write("HTTP-SERVER.json", { originalSource: "web/serve.ts", sourceUnchanged: true, originalFetchReceiverAndTuplePreserved: true, originalCacheAndWasmSemantics: true,
    diagnosticOnlyPaths: ["/evidence", "/gate"] });
}

async function gate(request: Request, headers: Record<string, string>) {
  const { phase, raw: value } = await request.json();
  assert(mode === "qualify" && typeof phase === "string" && /^[a-z-]+$/.test(phase));
  const complete = { ...value, browser: browser?.version(), contextCount: 1, pageCount: browser?.contexts()[0]?.pages().length };
  await write(`gate-${complete.capture}-${phase}-raw.json`, complete);
  try {
    const result = qualify(complete, phase);
    await write(`gate-${complete.capture}-${phase}-qualified.json`, result);
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    await write(`gate-${complete.capture}-${phase}-error.json`, { error: String(error) });
    return Response.json({ ok: false, error: String(error) }, { status: 422, headers });
  }
}
async function qualification(base: string) {
  assert(browser);
  const context = await browser.newContext();
  contextCount++;
  try {
    await arm(context);
    observe(context);
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    for (const [index, page] of pages.entries()) {
      const template = index === 0 ? "hono" : "vanilla";
      await page.goto(base + `?template=${template}&engine=browser&profile=split&entryControls=labelled`, { timeout: 240000 });
      await page.waitForFunction(() => { const app = Reflect.get(globalThis, "sandbox"); return app && ["ok", "error"].includes(app.status().kind); }, undefined, { timeout: 240000 });
    }
    const values = await Promise.all(pages.map(raw));
    await write("two-pages-raw.json", values);
    const scoped = values.map(value => ({ ...value, contextCount: 1, pageCount: 2 }));
    const qualified = scoped.map(value => qualify(value, "final"));
    assert.notEqual(values[0].capture, values[1].capture);
    const clients = scoped.map(value => value.rows.filter((row: Record<string, unknown>) => row.entry === "bun" && row.cell === "original-install" && row.stage === "before-original-handlers"));
    assert.equal(clients[0].length, 1); assert.equal(clients[1].length, 1);
    const first = endpointIdentity(clients[0][0], { endpoint: "client", entry: "bun" });
    const second = endpointIdentity(clients[1][0], { endpoint: "client", entry: "bun" });
    assert(first && second);
    assert.equal(first.owner, second.owner); assert.equal(first.generation, second.generation);
    assert.equal(clients[0][0].pid, clients[1][0].pid);
    assert.equal(sameConnection(first, second), false);
    const otherServices = scoped[1].rows.map((row: unknown) => endpointIdentity(row, { endpoint: "service" })).filter(Boolean);
    assert(otherServices.every((service: NonNullable<typeof first>) => !sameConnection(first, service)));
    for (const key of ["runtimeId", "workerId", "capture"]) {
      const missing = { ...clients[0][0] }; delete missing[key];
      assert.equal(endpointIdentity(missing, { endpoint: "client", entry: "bun" }), null);
    }
    for (const page of pages) await page.evaluate(() => Reflect.get(globalThis, "sandboxObserver").rejectControls());
    for (const page of pages) await page.waitForFunction(() => Reflect.get(globalThis, "sandboxObserver").snapshot().rows.filter((row: Record<string, unknown>) => row.kind === "control-rejected").length === 4, undefined, { timeout: 60000 });
    const rejected = await Promise.all(pages.map(raw));
    await write("two-pages-negative-controls-raw.json", rejected);
    const streamed = (await Bun.file(join(output, "raw-endpoints.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
    for (const value of rejected) {
      const own = streamed.filter(row => row.capture === value.capture).sort((a, b) => a.collectorSequence - b.collectorSequence);
      assert.deepEqual(own, JSON.parse(JSON.stringify(value.rows)), "complete raw rows reached the host before qualification");
      const refusals = value.rows.filter((row: Record<string, unknown>) => row.kind === "control-rejected");
      assert.equal(refusals.length, 4);
      assert(!value.rows.some((row: Record<string, unknown>) => row.kind === "service-snapshot-complete" && row.token === "must-reject"));
    }
    await write("QUALIFIED.json", { qualified, overlappingOwnersAndPids: true, genuineOwnServices: true, crossPagePairRejected: true, invalidControlsRejected: true, durationMs: Date.now() - started });
  } finally { await closing(context); }
}
try {
  await mkdir(temporary);
  process.env.TMPDIR = temporary;
  await startServer();
  assert(server);
  port = server.port;
  await write("resources.json", { pid: process.pid, port, temporary, staged, executable: firefox.executablePath() });
  const acquired = await lifetime.acquire("browser.launch", () => firefox.launch({ headless: true }), value => value.close());
  browser = acquired.value;
  lifetime.observeBrowser(browser);
  const base = `http://127.0.0.1:${port}/sandbox/`;
  if (mode === "qualify") await qualification(base);
  else {
    assert(await Bun.file(join(evidence, "qualify/QUALIFIED.json")).exists(), "same-build hosted controls required");
    assert(!new URL(base).searchParams.has("entryControls"));
    contextCount++;
    await preservationScenario(browser, base, observation);
  }
  await write("OUTCOME.json", { outcome: "passed", mode, diagnosticOnly: true, durationMs: Date.now() - started });
} catch (error) {
  await write("OUTCOME.json", { outcome: "failed", mode, error: String(error), stack: error instanceof Error ? error.stack : null, originalReport: error && typeof error === "object" && "report" in error ? error.report : null, diagnosticOnly: true, durationMs: Date.now() - started });
  throw error;
} finally {
  clearTimeout(hang);
  try { await cleanup(); }
  finally {
    const after = verifySite(original);
    assert.deepEqual(after, before);
    execFileSync(process.execPath, [join(repo, "scripts/browser-guest-site.ts"), "verify", original], { cwd: repo, stdio: "inherit" });
    const listening = port ? await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false) : false;
    await write("CLEANUP.json", { browserClosed: !browser?.isConnected(), listenerStopped: !listening, temporaryRemoved: !existsSync(temporary), port,
      originalSiteVerifierAfter: true, durationMs: Date.now() - started, processSnapshot: execFileSync("ps", ["-eo", "pid,ppid,pgid,comm"], { encoding: "utf8" }) });
    assert(!listening); assert(!existsSync(temporary));
  }
}
