import assert from "node:assert/strict";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Runtime } from "waffle";
import type { Editor } from "../src/editor";
import type { Terminal } from "@xterm/xterm";
import { workspaceName } from "../src/workspace-policy";

declare const sandbox: { fs: Runtime["filesystem"]; editor: Editor; term?: Terminal };
const APP = "/home/user/app";
const STARTUP_MS = 180_000;

async function openTemplate(page: Page, base: string, template: string): Promise<void> {
  const url = new URL(base);
  url.searchParams.set("template", template);
  url.searchParams.set("engine", "browser");
  await page.goto(url.href);
  await ready(page, template);
}

async function ready(page: Page, template: string): Promise<void> {
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")?.dataset.kind === "error" || /dev server ready/.test(document.querySelector("#status")?.textContent ?? ""), undefined, { timeout: STARTUP_MS });
  const status = await page.locator("#status").textContent();
  assert.equal(await page.locator("#status").getAttribute("data-kind"), "ok", `startup failed ${template}: ${status}`);
  await page.evaluate(() => sandbox.fs.flush());
}

async function restart(page: Page): Promise<void> {
  await page.locator("#restart").click();
  await page.waitForFunction(() => document.querySelector("#server-dot")?.getAttribute("data-state") === "starting");
  await ready(page, "restarted workspace");
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
  try {
    const active = await context.newPage();
    const page = await context.newPage();
    await openTemplate(active, base, "hono");
    await active.frameLocator("#preview").locator("#increment:not([disabled])").click();
    await openTemplate(page, base, "vanilla");
    const original = await page.evaluate(async () => new TextDecoder().decode(await sandbox.fs.readFile("/home/user/app/src/main.ts")));
    const main = original.replace('import "./App.css";\n', "").replace("Hello from vanilla TypeScript", "Storage source one");
    await edit(page, "src/main.ts", main);
    await edit(page, "vite.config.ts", guestWriter);
    await restart(page);
    await page.frameLocator("#preview").getByRole("heading", { name: "Storage source one", exact: true }).waitFor({ timeout: 30_000 });
    await page.evaluate(() => sandbox.fs.flush());
    await openTemplate(page, base, "vite-react");
    await openTemplate(page, base, "vite-vue");
    assert.equal(await stored(page, "vanilla"), false, "oldest eligible install was not evicted");
    assert.equal(await stored(page, "vite-react"), true, "newest idle install was not retained");
    assert.equal(await stored(page, "hono"), true, "active workspace was evicted");
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
    console.error(JSON.stringify({ error: String(error), errors, pages }, null, 2));
    throw error;
  } finally { await context.close(); }
}

async function diagnostic(page: Page): Promise<unknown> {
  if (page.isClosed()) return "closed";
  return page.evaluate(() => {
    const buffer = sandbox.term?.buffer.active;
    const terminal = buffer ? Array.from({ length: Math.min(buffer.length, 80) }, (_, index) => buffer.getLine(Math.max(0, buffer.length - 80) + index)?.translateToString(true) ?? "").join("\n") : "";
    return { url: location.href, status: document.querySelector("#status")?.textContent, storage: document.querySelector("#storage-status")?.textContent, terminal };
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

export interface StorageRun {
  readonly template: string;
  readonly elapsedMs: number;
  readonly status: string;
  readonly error?: string;
  readonly storage: StorageEstimate & { readonly databases: readonly (string | undefined)[] };
  readonly eviction: unknown;
}

export async function accumulation(context: BrowserContext, base: string, templates: readonly string[]): Promise<StorageRun[]> {
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
      rows.push({ template, elapsedMs: Math.round(performance.now() - started), status, error, storage, eviction });
      if (error) break;
    }
  } finally { await page.close(); }
  return rows;
}
