import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Runtime } from "waffle";
import type { Previews } from "../src/preview";
import type { Editor } from "../src/playground/editor";
import { playwright, ready, run, session, terminalText } from "./playground.mjs";
import { stopForeground } from "./foreground";
import { checkPlaygroundStdin } from "./playground-stdin";

type PlaygroundGlobal = typeof globalThis & {
  playground: {
    shell: { submit(command: string): Promise<void>; running: boolean; lastExit: number };
    previews: Previews;
    editor: Editor;
    fs: Runtime["filesystem"];
  };
};
const reports = process.env.VITE_REPORTS;
if (reports) mkdirSync(reports, { recursive: true });
const task = session("bun-wasm-vite-");
const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(1)); }, 600000);

async function command(page: Page, text: string, timeout = 120000) {
  const result = await run(page, text, timeout);
  console.log(text, JSON.stringify(result));
  assert.equal(result.code, 0, `${text}: ${result.output}`);
  return result;
}

async function startServer(page: Page, command: string): Promise<string> {
  await page.evaluate(command => { void (globalThis as PlaygroundGlobal).playground.shell.submit(command); }, command);
  await page.waitForFunction(() => (globalThis as PlaygroundGlobal).playground.previews.serves(5173), undefined, { timeout: 60000 });
  assert.equal(await page.evaluate(() => (globalThis as PlaygroundGlobal).playground.previews.ready), "ready");
  return page.evaluate(() => (globalThis as PlaygroundGlobal).playground.previews.url(5173));
}

async function editComponent(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { editor } = (globalThis as PlaygroundGlobal).playground;
    await editor.open("/home/user/src/App.tsx");
    const source = editor.view.state.doc.toString();
    const updated = source.replace("Hello from bun.wasm", "Vite React hot updated");
    if (source === updated) throw new Error("Missing initial component heading");
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: updated } });
    await editor.save();
  });
}

async function development(page: Page): Promise<void> {
  const url = await startServer(page, "bun run dev");
  const preview = await page.context().newPage();
  try {
    const connected = preview.waitForEvent("console", { predicate: message => message.text().includes("[vite] connected."), timeout: 60000 });
    const response = await preview.goto(url);
    assert.equal(response?.status(), 200);
    await preview.getByRole("heading", { name: "Hello from bun.wasm", exact: true }).waitFor({ timeout: 60000 });
    await connected;
    await preview.getByRole("button", { name: "count is 0" }).click();
    let navigations = 0;
    preview.on("framenavigated", frame => { if (frame === preview.mainFrame()) navigations++; });
    await preview.evaluate(() => Reflect.set(globalThis, "viteHmrIdentity", "same-document"));
    await editComponent(page);
    await preview.getByRole("heading", { name: "Vite React hot updated", exact: true }).waitFor({ timeout: 30000 });
    await preview.getByRole("button", { name: "count is 1" }).waitFor();
    assert.equal(navigations, 0, "HMR must not navigate the preview");
    assert.equal(await preview.evaluate(() => Reflect.get(globalThis, "viteHmrIdentity")), "same-document");
    if (reports) await preview.screenshot({ path: join(reports, "vite-react-hmr.png") });
    console.log("PASS Vite 8 development render and React Fast Refresh, counter retained, zero navigations");
  } finally { await preview.close(); await stopForeground(page); }
}

async function builtPreview(page: Page): Promise<void> {
  await command(page, "bun run build", 180000);
  const url = await startServer(page, "bun run node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort");
  const preview = await page.context().newPage();
  try {
    const response = await preview.goto(url);
    assert.equal(response?.status(), 200);
    await preview.getByRole("heading", { name: "Vite React hot updated", exact: true }).waitFor({ timeout: 30000 });
    await preview.getByRole("button", { name: "count is 0" }).click();
    await preview.getByRole("button", { name: "count is 1" }).waitFor();
    console.log("PASS Vite 8 production build and vite preview render with working React counter");
  } finally { await preview.close(); await stopForeground(page); }
}

let page: Page | undefined;
try {
  const url = new URL(process.env.VITE_PLAYGROUND_URL ?? await task.serve());
  url.searchParams.set("template", "vite-react");
  url.searchParams.set("engine", "browser");
  url.searchParams.set("prompt", "off");
  url.searchParams.set("mode", "memory");
  const browser = await task.launch(playwright.chromium);
  const context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", error => console.error("PAGE ERROR", error.message));
  await page.goto(url.href);
  assert.match(await ready(page), /ready · Browser/);
  assert.equal(await page.evaluate(() => (globalThis as PlaygroundGlobal).playground.editor.path), "/home/user/src/App.tsx");
  await checkPlaygroundStdin(page);
  await command(page, "bun install", 240000);
  await development(page);
  await builtPreview(page);
} finally {
  clearTimeout(timer);
  if (reports && page && !page.isClosed()) writeFileSync(join(reports, "terminal.log"), await terminalText(page).catch(String));
  await task.cleanup();
}
