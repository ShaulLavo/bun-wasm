import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { webkit, type Page, type Browser, type BrowserContext } from "playwright";
import type { StorageDiagnostic } from "./storage-webkit-observer";

declare const __storageDiagnostic: StorageDiagnostic;
declare const sandbox: { fs: { readFile(path: string): Promise<Uint8Array> }; editor: { open(path: string): Promise<void>; setText(text: string): void; flushAll(): Promise<void> } };
const subject = resolve(process.env.STORAGE_SUBJECT ?? ".");
const artifact = resolve(process.env.BUN_WASM_BROWSER_SITE ?? "missing-site");
const report = resolve(process.env.BUN_WASM_BROWSER_REPORT_DIR ?? "missing-report");
mkdirSync(report, { recursive: true });
const { verifySite } = await import(pathToFileURL(join(subject, "scripts/browser-guest-site.ts")).href);
const { openTemplate, restart, preservationScenario }: { openTemplate(page: Page, base: string, template: string): Promise<void>; restart(page: Page): Promise<void>; preservationScenario(browser: Browser, base: string): Promise<void> } = await import(pathToFileURL(join(subject, "sandbox/tests/storage-browser.ts")).href);
const { session } = await import(pathToFileURL(join(subject, "web/tests/playground.mjs")).href);
const identity = verifySite(artifact);
writeFileSync(join(report, "identity.json"), JSON.stringify({ diagnosticHead: process.env.DIAGNOSTIC_HEAD, subject: identity.source, guest: identity.guest, artifactRun: 43516069702, artifactId: 14082579799 }, null, 2));
let browser: Browser;
const contexts: BrowserContext[] = [];
const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "storage-webkit-observer.ts")], target: "browser" });
if (!bundle.success) throw new Error(String(bundle.logs));
const observer = await bundle.outputs[0]!.text();
const task = session("storage-webkit-diagnostic-");
const pageReports = new Map<Page, { label: string; console: unknown[]; errors: string[] }>();
let nextPage = 0;
async function observe(context: BrowserContext, label: string) {
  contexts.push(context);
  await context.addInitScript({ content: observer });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  context.on("page", page => {
    const entry: { label: string; console: unknown[]; errors: string[] } = { label: `${label}-${++nextPage}`, console: [], errors: [] };
    pageReports.set(page, entry);
    page.on("console", message => entry.console.push({ type: message.type(), text: message.text() }));
    page.on("pageerror", error => entry.errors.push(String(error)));
    page.on("close", () => { entry.errors.push("page closed"); });
  });
}
async function retain(page: Page) {
  if (page.isClosed()) return;
  const entry = pageReports.get(page);
  if (!entry) return;
  const state = await page.evaluate(() => ({ url: location.href, diagnostic: __storageDiagnostic.snapshot(), status: document.querySelector("#status")?.textContent, body: document.body.innerText })).catch(error => ({ error: String(error) }));
  writeFileSync(join(report, `${entry.label}.json`), JSON.stringify({ ...entry, state }, null, 2));
  await page.screenshot({ path: join(report, `${entry.label}.png`), fullPage: true }).catch(() => {});
}
async function marker(page: Page, label: string) { await page.evaluate(label => __storageDiagnostic.mark(label), label); }
async function edit(page: Page, path: string, text: string) {
  await marker(page, `before edit ${path}`);
  await page.evaluate(async ({ path, text }) => { await sandbox.editor.open(path); sandbox.editor.setText(text); await sandbox.editor.flushAll(); }, { path, text });
  await marker(page, `after edit ${path}`);
}
const beforeRoot = process.env.ROOT;
try {
  browser = await task.launch(webkit);
  process.env.ROOT = join(artifact, "site");
  const base = new URL("sandbox/", await task.serve()).href;
  const control = await browser.newContext();
  await observe(control, "control");
  const page = await control.newPage();
  await openTemplate(page, base, "vanilla");
  await marker(page, "control ready");
  const config = "export default {};\n";
  await edit(page, "vite.config.ts", config);
  await restart(page);
  await marker(page, "control sandbox replacement ready");
  await edit(page, "vite.config.ts", `${config}\n// storage diagnostic self-restart control\n`);
  await page.waitForFunction(() => __storageDiagnostic.snapshot().output.includes("server restarted"), undefined, { timeout: 30000 });
  await marker(page, "control Vite self-restart observed");
  const state = await page.evaluate(() => __storageDiagnostic.snapshot());
  assert.equal(state.dropped, 0);
  assert(state.events.some(event => event.kind === "process-captured"), "Observer captured Browser-native process transport");
  assert(state.events.some(event => event.kind === "terminate-returned"), "Observer captured sandbox physical stop");
  assert(state.filesystem.some(value => value.revoked.some(word => word !== 0)), "Observer captured filesystem revocation");
  assert(state.processes.some(value => value.state?.kind === "terminated"), "Observer captured native return outcome");
  assert(!state.events.some(event => event.kind === "capture-error"), "All process observations qualified");
  await retain(page);
  await control.tracing.stop({ path: join(report, "control-trace.zip") });
  await control.close();
  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await originalNewContext(options);
    await observe(context, "preservation");
    context.on("page", page => {
      page.on("domcontentloaded", () => { void marker(page, "preservation document loaded").catch(() => {}); });
    });
    const close = context.close.bind(context);
    context.close = async options => {
      await Promise.all(context.pages().map(retain));
      await context.tracing.stop({ path: join(report, "preservation-trace.zip") });
      await close(options);
    };
    return context;
  };
  await preservationScenario(browser, base);
  assert.deepEqual(verifySite(artifact), identity);
  writeFileSync(join(report, "result.json"), JSON.stringify({ outcome: "passed", positiveControl: "passed" }));
} catch (error) {
  writeFileSync(join(report, "result.json"), JSON.stringify({ outcome: "failed", error: String(error), stack: error instanceof Error ? error.stack : undefined }));
  throw error;
} finally {
  await Promise.all(Array.from(pageReports.keys(), retain));
  await Promise.all(contexts.map(context => context.tracing.stop({ path: join(report, `final-trace-${contexts.indexOf(context)}.zip`) }).catch(() => {})));
  if (beforeRoot === undefined) delete process.env.ROOT;
  else process.env.ROOT = beforeRoot;
  await task.cleanup();
  writeFileSync(join(report, "cleanup.json"), JSON.stringify({ taskScratch: task.scratch, taskScratchRemoved: !existsSync(task.scratch), taskCleanup: "resolved" }));
}
