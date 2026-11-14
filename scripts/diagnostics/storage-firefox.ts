import assert from "node:assert/strict";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { firefox, type BrowserContext, type Page, type Browser } from "playwright";
import { installPortObserver } from "./storage-firefox-observer";

const subject = resolve(process.env.STORAGE_SUBJECT ?? ".");
const artifact = resolve(process.env.BUN_WASM_BROWSER_SITE ?? "missing-site");
const report = resolve(process.env.BUN_WASM_BROWSER_REPORT_DIR ?? "missing-report");
mkdirSync(report, { recursive: true });
const events: unknown[] = [];
const contexts: BrowserContext[] = [];
const { verifySite } = await import(pathToFileURL(join(subject, "scripts/browser-guest-site.ts")).href);
const { preservationScenario }: { preservationScenario(browser: Browser, base: string): Promise<void> } = await import(pathToFileURL(join(subject, "sandbox/tests/storage-browser.ts")).href);
const { session } = await import(pathToFileURL(join(subject, "web/tests/playground.mjs")).href);
let collector: ReturnType<typeof Bun.serve> | undefined;
const previousRoot = process.env.ROOT;
const pages = new Map<Page, number>();
let nextPage = 0;
const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "storage-firefox-observer.ts")], target: "browser", format: "esm" });
if (!bundle.success) throw new AggregateError(bundle.logs);
const probe = await bundle.outputs[0]!.text();
const identity = verifySite(artifact);
writeFileSync(join(report, "identity.json"), JSON.stringify({ diagnosticHead: process.env.DIAGNOSTIC_HEAD, subject: identity.source, guest: identity.guest, artifactRun: 43530616509, artifactId: 14088892486 }, null, 2));
const task = session("storage-firefox-diagnostic-");
async function retain(page: Page): Promise<void> {
  const id = pages.get(page);
  if (id === undefined || page.isClosed()) return;
  const state = await page.evaluate(() => ({ url: location.href, status: document.querySelector("#status")?.textContent, text: document.body.innerText })).catch(error => ({ error: String(error) }));
  writeFileSync(join(report, `page-${id}.json`), JSON.stringify(state, null, 2));
  await page.screenshot({ path: join(report, `page-${id}.png`) }).catch(() => {});
}
async function observe(context: BrowserContext, label: string): Promise<void> {
  contexts.push(context);
  const endpoint = new URL("events", collector!.url).href;
  const prefix = `;(${installPortObserver.toString()})(${JSON.stringify(endpoint)});\n`;
  await context.addInitScript({ content: prefix });
  await context.route(/\.js(?:\?|$)/, async route => {
    const response = await route.fetch();
    const original = await response.text();
    await route.fulfill({ response, body: prefix + original });
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  context.on("page", page => {
    const id = ++nextPage;
    pages.set(page, id);
    page.on("console", message => appendFileSync(join(report, "console.ndjson"), JSON.stringify({ label, page: id, type: message.type(), text: message.text() }) + "\n"));
    page.on("pageerror", error => appendFileSync(join(report, "console.ndjson"), JSON.stringify({ label, page: id, error: String(error) }) + "\n"));
  });
  const close = context.close.bind(context);
  context.close = async options => {
    try {
      await Promise.all(context.pages().map(retain));
      await context.tracing.stop({ path: join(report, `${label}-trace.zip`) });
    } finally { await close(options); }
  };
}
try {
  collector = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
    if (url.pathname === "/events") {
      const body = await request.text();
      const batch: unknown = JSON.parse(body);
      if (!Array.isArray(batch)) return new Response("invalid batch", { status: 400, headers });
      events.push(...batch);
      appendFileSync(join(report, "ports.ndjson"), batch.map(event => JSON.stringify(event)).join("\n") + "\n");
      return new Response("ok", { headers });
    }
    if (url.pathname === "/probe.js") return new Response(probe, { headers: { ...headers, "Content-Type": "text/javascript" } });
    return new Response('<script type="module">import { qualify } from "/probe.js"; globalThis.qualification = qualify(new URL("/probe.js", location.href).href);</script>', { headers: { ...headers, "Content-Type": "text/html" } });
  } });
  const browser: Browser = await task.launch(firefox);
  const control = await browser.newContext();
  await observe(control, "qualification");
  const page = await control.newPage();
  await page.goto(collector.url.href);
  await page.waitForFunction(() => "qualification" in globalThis);
  const qualification = await page.evaluate(() => Reflect.get(globalThis, "qualification"));
  await page.waitForTimeout(500);
  writeFileSync(join(report, "qualification.json"), JSON.stringify({ result: qualification, events }, null, 2));
  assert.equal(qualification.isolated, true);
  assert.equal(typeof qualification.before.root, "number");
  assert.equal(qualification.after.closed, true);
  assert.equal(typeof qualification.healthyRoot, "number");
  const observed = JSON.stringify(events);
  assert.match(observed, /"kind":"messageerror"/);
  assert.match(observed, /"transportClosed":true/);
  assert.match(observed, /"buffer":\{"kind":"shared"/);
  await control.close();
  process.env.ROOT = join(artifact, "site");
  const base = new URL("sandbox/", await task.serve()).href;
  const createContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await createContext(options);
    await observe(context, "preservation");
    return context;
  };
  await preservationScenario(browser, base);
  assert.deepEqual(verifySite(artifact), identity);
  writeFileSync(join(report, "result.json"), JSON.stringify({ outcome: "passed", qualification: "passed" }));
} catch (error) {
  writeFileSync(join(report, "result.json"), JSON.stringify({ outcome: "failed", error: String(error), stack: error instanceof Error ? error.stack : undefined }));
  throw error;
} finally {
  try { await Promise.all(contexts.map(context => context.close().catch(() => {}))); }
  finally {
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
    let cleaned = false;
    try { await task.cleanup(); cleaned = true; }
    finally {
      collector?.stop(true);
      writeFileSync(join(report, "cleanup.json"), JSON.stringify({ scratch: task.scratch, scratchRemoved: !existsSync(task.scratch), cleanup: cleaned ? "completed" : "failed", events: events.length }));
    }
  }
}
