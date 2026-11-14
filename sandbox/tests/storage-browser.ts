import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Worker as PlaywrightWorker } from "playwright";
import type { Runtime } from "waffle";
import type { Editor } from "../src/editor";
import type { Terminal } from "@xterm/xterm";
import { workspaceName } from "../src/workspace-policy";
import type { PreviewNavigation, Status } from "../src/sandbox";
import { frameworks } from "../../scripts/goals-matrix/catalog";

declare const sandbox: {
  fs: Runtime["filesystem"]; editor: Editor; term?: Terminal; started?: () => boolean;
  template: string; server: () => PreviewNavigation["server"] | null;
  preview: () => PreviewNavigation | null; status: () => Status;
};
declare const storageReadiness: { candidate(selector: string): { checkpoint(): Promise<boolean> } | false };
const APP = "/home/user/app";
const STARTUP_MS = 180_000;
const observedPages = new WeakSet<Page>();

function installReadiness(): void {
  if (window !== window.top) return;
  let failure = "";
  const observeErrors = (records: MutationRecord[] = []) => {
    const status = document.querySelector<HTMLElement>("#status");
    if (status?.dataset.kind === "error") failure ||= status.textContent || "startup error";
    if (records.some(record => record.target === status && record.attributeName === "data-kind" && record.oldValue === "error")) failure ||= "startup error before status changed";
  };
  const observer = new MutationObserver(observeErrors);
  observer.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-kind"], attributeOldValue: true, childList: true });
  window.addEventListener("error", event => { failure ||= event.message || "page error"; });
  window.addEventListener("unhandledrejection", event => { failure ||= String(event.reason); });
  const checkErrors = () => {
    observeErrors(observer.takeRecords());
    if (failure) throw new Error(failure);
    if (typeof sandbox === "undefined") return;
    if (sandbox.status().kind === "error") throw new Error(sandbox.status().text);
    if (sandbox.fs.state.status === "failed") throw sandbox.fs.state.error;
  };
  const candidate = (selector: string) => {
    checkErrors();
    if (typeof sandbox === "undefined") return false;
    const api = sandbox;
    const parent = document;
    const navigation = api.preview();
    const server = api.server();
    const loaded = navigation?.loaded;
    if (!navigation || !loaded || !server) return false;
    const preview = loaded.document;
    const current = () => {
      checkErrors();
      const status = document.querySelector<HTMLElement>("#status");
      return document === parent && sandbox === api && api.server() === server && api.preview() === navigation && navigation.server === server
        && document.querySelector("#preview") === navigation.frame && navigation.frame.contentDocument === preview
        && navigation.loaded === loaded && navigation.frame.src === navigation.url && preview.URL === loaded.url && preview.readyState === "complete"
        && api.started?.() === true && api.fs.state.status === "ready" && document.querySelector("#server-dot")?.getAttribute("data-state") === "up"
        && api.status().kind === "ok" && status?.dataset.kind === "ok" && /dev server ready/.test(status.textContent ?? "")
        && preview.querySelector(selector) !== null;
    };
    if (!current()) return false;
    return { checkpoint: async () => {
      if (!current()) return false;
      await api.fs.flush();
      return current();
    } };
  };
  Object.assign(globalThis, { storageReadiness: { candidate } });
}

async function observeReadiness(page: Page): Promise<void> {
  if (observedPages.has(page)) return;
  await page.addInitScript(installReadiness);
  observedPages.add(page);
}

function previewSelector(template: string): string {
  if (template === "vanilla") return "button.counter:not([disabled])";
  const framework = frameworks.find(item => item.template === (template === "next-app" ? "next" : template));
  if (!framework) throw new Error(`Missing preview readiness selector for ${template}`);
  return `${framework.button}:not([disabled])`;
}

export function storageReportPath(env = process.env): string | undefined {
  const directory = env.BUN_WASM_BROWSER_REPORT_DIR;
  return env.BUN_WASM_STORAGE_REPORT ?? (directory ? join(directory, "sandbox-storage.json") : undefined);
}

export async function openTemplate(page: Page, base: string, template: string): Promise<void> {
  const deadline = Date.now() + STARTUP_MS;
  await observeReadiness(page);
  const url = new URL(base);
  url.searchParams.set("template", template);
  url.searchParams.set("engine", "browser");
  await page.bringToFront();
  await page.goto(url.href, { timeout: remaining(deadline) });
  await ready(page, template, deadline);
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("Storage readiness exceeded its startup deadline");
  return ms;
}

async function checkpoint(page: Page, selector: string, deadline: number): Promise<boolean> {
  const candidate = await page.waitForFunction(selector => storageReadiness.candidate(selector), selector, { timeout: remaining(deadline) });
  try { return await candidate.evaluate(candidate => candidate ? candidate.checkpoint() : false); }
  finally { await candidate.dispose(); }
}

export async function ready(page: Page, template: string, deadline = Date.now() + STARTUP_MS): Promise<void> {
  const selector = previewSelector(template);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Storage readiness deadline: ${template}`)), remaining(deadline)); });
  try { await Promise.race([waitUntilReady(page, selector, deadline), expired]); }
  finally { clearTimeout(timer); }
}

async function waitUntilReady(page: Page, selector: string, deadline: number): Promise<void> {
  while (remaining(deadline)) {
    try { if (await checkpoint(page, selector, deadline)) return; }
    catch (error) {
      if (!(error instanceof Error) || !/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
    }
  }
}

export async function restart(page: Page): Promise<void> {
  const deadline = Date.now() + STARTUP_MS;
  const previous = await page.evaluateHandle(() => sandbox.server());
  try {
    await page.locator("#restart").click({ timeout: remaining(deadline) });
    await page.waitForFunction(previous => sandbox.server() !== previous, previous, { timeout: remaining(deadline) });
    await ready(page, await page.evaluate(() => sandbox.template), deadline);
  } finally { await previous.dispose(); }
}

async function edit(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(async ({ path, text }) => {
    await sandbox.editor.open(path);
    sandbox.editor.setText(text);
    await sandbox.editor.flushAll();
  }, { path, text });
}

async function stored(page: Page, template: string): Promise<boolean> {
  return page.evaluate(async name => (await indexedDB.databases()).some(database => database.name === name), workspaceName(template));
}

const guestWriter = `import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
if (!existsSync("/home/user/app/.config/written")) {
  mkdirSync("/home/user/app/.config", { recursive: true });
  mkdirSync("/home/user/app/build", { recursive: true });
  mkdirSync("/home/user/app/dist", { recursive: true });
  mkdirSync("/home/user/app/empty", { recursive: true });
  writeFileSync("/home/user/app/.env", "USER_DOTFILE=kept");
  writeFileSync("/home/user/app/.config/written", "guest data");
  writeFileSync("/home/user/app/build/user.txt", "user build data");
  writeFileSync("/home/user/app/dist/user.txt", "user dist data");
  writeFileSync("/home/user/outside.bin", Buffer.from([0, 255, 128, 1]));
  if (existsSync("/home/user/app/src/App.css")) unlinkSync("/home/user/app/src/App.css");
}
export default {};
`;

export async function preservationScenario(browser: Browser, base: string): Promise<void> {
  const context = await browser.newContext();
  const errors: string[] = [];
  context.on("page", page => {
    page.on("pageerror", error => { errors.push(error.message); });
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  });
  let checkpoint: StoragePreservationFailure["report"]["checkpoint"] = "setup";
  try {
    const active = await context.newPage();
    const page = await context.newPage();
    await openTemplate(active, base, "hono");
    const server = await active.evaluate(async () => new TextDecoder().decode(await sandbox.fs.readFile("/home/user/app/server.ts")));
    assert.match(server, /port: 5173/);
    await edit(active, "server.ts", server.replace("port: 5173", "port: 5174"));
    await restart(active);
    assert.match(await active.locator("#preview").getAttribute("src") ?? "", /\/5174\//);
    await active.frameLocator("#preview").locator("#increment:not([disabled])").click();
    await openTemplate(page, base, "vanilla");
    const original = await page.evaluate(async () => new TextDecoder().decode(await sandbox.fs.readFile("/home/user/app/src/main.ts")));
    const main = original.replace('import "./App.css";\n', "").replace("Hello from vanilla TypeScript", "Storage source one");
    await edit(page, "src/main.ts", main);
    await edit(page, "vite.config.ts", guestWriter);
    checkpoint = "vanilla-config-restart";
    await restart(page);
    checkpoint = "preservation";
    await page.frameLocator("#preview").getByRole("heading", { name: "Storage source one", exact: true }).waitFor({ timeout: 30_000 });
    await page.evaluate(() => sandbox.fs.flush());
    checkpoint = "first-vite-react-startup";
    await openTemplate(page, base, "vite-react");
    checkpoint = "first-vite-vue-startup";
    await openTemplate(page, base, "vite-vue");
    checkpoint = "preservation";
    assert.equal(await stored(page, "vanilla"), false, "oldest eligible install was not evicted");
    assert.equal(await stored(page, "vite-react"), true, "newest idle install was not retained");
    assert.equal(await stored(page, "hono"), true, "active workspace was evicted");
    assert.equal(await active.locator("#server-dot").getAttribute("data-state"), "up", "active Hono server was stopped");
    assert.equal(await active.frameLocator("#preview").locator("#count").textContent(), "1");
    await openTemplate(page, base, "vanilla");
    await retainedUserTree(page);
    const preview = page.frameLocator("#preview");
    await preview.locator("button.counter").click();
    const documentId = await preview.locator("body").evaluate(() => performance.timeOrigin);
    await edit(page, "src/main.ts", main.replace("Storage source one", "Storage source two"));
    await page.frameLocator("#preview").getByRole("heading", { name: "Storage source two", exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await preview.locator("body").evaluate(() => performance.timeOrigin), documentId, "restored source HMR replaced the document");
    await preview.locator("button.counter", { hasText: "count is 1" }).waitFor();
    await openTemplate(page, base, "vite-react");
    await openTemplate(page, base, "vite-vue");
    assert.equal(await stored(page, "vanilla"), false, "edited restored source was not evicted again");
    await openTemplate(page, base, "vanilla");
    await page.frameLocator("#preview").getByRole("heading", { name: "Storage source two", exact: true }).waitFor({ timeout: 30_000 });
    await retainedUserTree(page);
    await unsupportedData(page, base);
  } catch (error) {
    const pages = await Promise.all(context.pages().map(page => diagnostic(page)));
    const report = { checkpoint, error: String(error), errors, pages };
    console.error(JSON.stringify(report, null, 2));
    throw new StoragePreservationFailure(report, error);
  } finally { await context.close(); }
}

export class StoragePreservationFailure extends Error {
  constructor(readonly report: {
    checkpoint: "setup" | "vanilla-config-restart" | "first-vite-react-startup" | "first-vite-vue-startup" | "preservation";
    error: string; errors: readonly string[]; pages: readonly (StoragePageDiagnostic | string)[];
  }, cause: unknown) {
    super(report.error, { cause });
    this.name = "StoragePreservationFailure";
  }
}

interface StoragePageDiagnostic {
  url: string; status: string | null | undefined; storage?: string | null;
  terminal: string; frames: readonly { src: string; body?: string }[];
  runtime: null | {
    filesystem: { status: string; error?: string }; started: boolean | null;
    editorPath: string | null; pending: boolean;
  };
}

async function diagnostic(page: Page): Promise<StoragePageDiagnostic | string> {
  if (page.isClosed()) return "closed";
  return page.evaluate(() => {
    const api = typeof sandbox === "undefined" ? null : sandbox;
    const buffer = api?.term?.buffer.active;
    const terminal = buffer ? Array.from({ length: Math.min(buffer.length, 80) }, (_, index) => buffer.getLine(Math.max(0, buffer.length - 80) + index)?.translateToString(true) ?? "").join("\n") : "";
    const frames = Array.from(document.querySelectorAll("iframe"), frame => ({ src: frame.src, body: frame.contentDocument?.body?.innerText.slice(0, 2000) }));
    const runtime = api ? { filesystem: { ...api.fs.state, error: api.fs.state.error?.message }, started: api.started?.() ?? null, editorPath: api.editor.path, pending: api.editor.hasPending } : null;
    return { url: location.href, status: document.querySelector("#status")?.textContent, storage: document.querySelector("#storage-status")?.textContent, terminal, frames, runtime };
  }).catch(error => String(error));
}

async function retainedUserTree(page: Page): Promise<void> {
  const result = await page.evaluate(async app => {
    const text = async (path: string) => new TextDecoder().decode(await sandbox.fs.readFile(path));
    return {
      env: await text(`${app}/.env`), config: await text(`${app}/.config/written`),
      build: await text(`${app}/build/user.txt`), dist: await text(`${app}/dist/user.txt`),
      binary: Array.from(await sandbox.fs.readFile("/home/user/outside.bin") ?? []),
      empty: (await sandbox.fs.lookup(`${app}/empty`))?.kind,
      deleted: await sandbox.fs.lookup(`${app}/src/App.css`) === undefined,
    };
  }, APP);
  assert.deepEqual(result, { env: "USER_DOTFILE=kept", config: "guest data", build: "user build data", dist: "user dist data", binary: [0, 255, 128, 1], empty: "dir", deleted: true });
}

async function unsupportedData(page: Page, base: string): Promise<void> {
  const code = 'import { symlinkSync } from "node:fs";\n' + guestWriter.replace("export default", 'if (!existsSync("/home/user/app/user-link")) symlinkSync("/home/user/app/.env", "/home/user/app/user-link");\nexport default');
  await edit(page, "vite.config.ts", code);
  await restart(page);
  await page.evaluate(() => sandbox.fs.flush());
  await openTemplate(page, base, "vite-react");
  await openTemplate(page, base, "vite-vue");
  assert.equal(await stored(page, "vanilla"), true, "unsupported user symlink was destroyed");
  assert.match(await page.locator("#storage-status").textContent() ?? "", /symlink.*cannot be restored/i);
}

export async function quotaRefusalScenario(browser: Browser, base: string): Promise<void> {
  const context = await browser.newContext();
  traceStorage(context);
  const evidence: Record<string, unknown> = { browser: browser.version(), initialCap: 512 * 1024 * 1024, fullCap: 1024 };
  try {
    const page = await context.newPage();
    await page.goto(new URL("engine-builds.json", base).href);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: new URL(base).origin, quotaSize: 512 * 1024 * 1024 });
    await openTemplate(page, base, "hono");
    await openTemplate(page, base, "vanilla");
    const saved = await page.evaluate(() => sandbox.editor.view.state.doc.toString());
    await edit(page, "src/main.ts", saved.replace("Hello from vanilla TypeScript", "Saved before quota"));
    const before = await page.evaluate(() => ({ filesystem: sandbox.fs.state.status, started: sandbox.started?.() ?? null, editorPath: sandbox.editor.path, pending: sandbox.editor.hasPending, state: sandbox.editor.saveState }));
    evidence.before = before;
    assert.equal(before.filesystem, "ready");
    assert.equal(before.started, true);
    assert.equal(before.pending, false);
    const control = `sandbox-quota-control-${Date.now()}`;
    await createQuotaControl(page, control);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: new URL(base).origin, quotaSize: 1024 });
    // Chromium retains an earlier bucket space grant for up to 30 seconds.
    await page.waitForTimeout(31_000);
    const nativeFailure = await refusedControlWrite(page, control);
    evidence.nativeFailure = nativeFailure;
    assert.equal(nativeFailure, "QuotaExceededError", "control write did not prove full-origin refusal");
    const beforeUrl = page.url();
    const result = await page.evaluate(async () => {
      const editor = sandbox.editor;
      editor.setText(editor.view.state.doc.toString().replace("Saved before quota", "Unsaved after quota"));
      let error = "";
      try { await editor.flushAll(); } catch (failure) { error = String(failure); }
      return { error, pending: editor.hasPending, state: editor.saveState, text: editor.view.state.doc.toString() };
    });
    evidence.save = result;
    evidence.after = await diagnostic(page);
    assert.ok(result.error, "full-origin save unexpectedly succeeded");
    assert.equal(result.pending, true, "failed edit was forgotten");
    assert.equal(result.state.kind, "error");
    assert.match(result.text, /Unsaved after quota/);
    assert.equal(page.url(), beforeUrl, "storage failure navigated away");
    assert.equal(await stored(page, "hono"), true, "failed snapshot preservation deleted the idle workspace");
    assert.equal(await stored(page, "vanilla"), true, "active workspace was removed");
    assert.match(await page.locator("#status").textContent() ?? "", /Keep this page open/);
    assert.match(await page.locator("#storage-status").textContent() ?? "", /installs were kept/);
    assert.equal(await page.locator("#restart").textContent(), "Retry");
    evidence.passed = true;
  } catch (error) {
    const pages = await Promise.all(context.pages().map(page => diagnostic(page)));
    evidence.error = String(error);
    evidence.pages = pages;
    console.error(JSON.stringify({ error: String(error), pages }, null, 2));
    throw error;
  } finally {
    const report = storageReportPath();
    try { if (report) await Bun.write(`${report.replace(/\.json$/, "")}-refusal.json`, JSON.stringify(evidence, null, 2)); }
    finally { await context.close(); }
  }
}

async function createQuotaControl(page: Page, name: string): Promise<void> {
  await page.evaluate(async name => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    request.onsuccess = () => { Reflect.set(globalThis, name, request.result); resolve(); };
    request.onerror = () => reject(request.error);
  }), name);
}

async function refusedControlWrite(page: Page, name: string): Promise<string> {
  return page.evaluate(async name => new Promise<string>((resolve, reject) => {
    const database: unknown = Reflect.get(globalThis, name);
    if (!(database instanceof IDBDatabase)) { reject(new Error("Missing quota control database")); return; }
    const transaction = database.transaction("data", "readwrite", { durability: "strict" });
    transaction.objectStore("data").put(new Uint8Array(1024 * 1024), "refused");
    transaction.oncomplete = () => resolve("accepted");
    transaction.onabort = () => resolve(transaction.error?.name ?? "aborted");
    transaction.onerror = () => {};
  }), name);
}

export interface StorageRun {
  readonly template: string;
  readonly elapsedMs: number;
  readonly status: string;
  readonly error?: string;
  readonly storage: StorageEstimate & { readonly databases: readonly (string | undefined)[] };
  readonly eviction: unknown;
  readonly runtime: unknown;
  readonly diagnostic?: unknown;
}

export async function accumulation(context: BrowserContext, base: string, templates: readonly string[]): Promise<StorageRun[]> {
  traceStorage(context);
  const page = await context.newPage();
  const rows: StorageRun[] = [];
  try {
    for (const template of templates) {
      const started = performance.now();
      let error: string | undefined;
      try { await openTemplate(page, base, template); } catch (failure) { error = String(failure); }
      const status = await page.locator("#status").textContent() ?? "";
      const storage = await page.evaluate(async () => ({ ...await navigator.storage.estimate(), databases: (await indexedDB.databases()).map(database => database.name) }));
      const eviction = await page.evaluate(() => performance.getEntriesByName("bunwasm:storage-reclaim").map(entry => entry.toJSON()));
      const runtime = await page.evaluate(() => typeof sandbox === "undefined" ? null : { filesystem: { ...sandbox.fs.state, error: sandbox.fs.state.error?.message }, started: sandbox.started?.() ?? null, editorPath: sandbox.editor.path, pending: sandbox.editor.hasPending });
      const details = error ? await diagnostic(page) : undefined;
      rows.push({ template, elapsedMs: Math.round(performance.now() - started), status, error, storage, eviction, runtime, diagnostic: details });
      if (error) break;
    }
  } finally { await page.close(); }
  return rows;
}

function traceStorage(context: BrowserContext): void {
  if (process.env.BUN_WASM_STORAGE_TRACE !== "1") return;
  context.on("console", message => { if (message.text().startsWith("__storage_trace__")) console.error(message.text()); });
  context.on("page", page => { page.on("worker", worker => { void traceWorker(worker); }); });
}

async function traceWorker(worker: PlaywrightWorker): Promise<void> {
  try { await worker.evaluate(installStorageTrace); }
  catch (error) { console.error(`Storage trace attachment failed: ${String(error)}`); }
}

function installStorageTrace(): void {
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
    const transaction = original.apply(this, args);
    transaction.addEventListener("error", event => {
      const request = event.target;
      console.error("__storage_trace__", JSON.stringify({ database: this.name, stores: args[0], event: "error", name: request instanceof IDBRequest ? request.error?.name : transaction.error?.name, message: request instanceof IDBRequest ? request.error?.message : transaction.error?.message }));
    });
    transaction.addEventListener("abort", () => console.error("__storage_trace__", JSON.stringify({ database: this.name, stores: args[0], event: "abort", name: transaction.error?.name, message: transaction.error?.message })));
    return transaction;
  };
}
