import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Editor } from "../src/playground/editor";
import type { Previews } from "../src/preview";
import { playwright, ready, run, session, terminalText } from "./playground.mjs";
import { stopForeground } from "./foreground";

declare const playground: { editor: Editor; previews: Previews; shell: { submit(command: string): Promise<void> } };

const task = session("bun-wasm-next-playground-");
const reports = process.env.NEXT_DEV_REPORTS;
if (reports) mkdirSync(reports, { recursive: true });
const events: string[] = [];
let page: Page | undefined;
const deadline = setTimeout(() => { void task.cleanup().finally(() => process.exit(124)); }, 360_000);

async function setSource(page: Page, text: string): Promise<void> {
  await page.evaluate(async text => {
    const { editor } = playground;
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text } });
    await editor.save();
  }, text);
}

async function projectLinks(page: Page): Promise<void> {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const boxes = await page.getByRole("navigation", { name: "Projects" }).getByRole("link").evaluateAll(links => links.map(link => {
      const { left, right, top, bottom } = link.getBoundingClientRect();
      return { left, right, top, bottom };
    }));
    assert.equal(boxes.length, 3);
    assert.ok(boxes.every(box => box.left >= 0 && box.right <= width));
    assert.ok(boxes.every((box, index) => index === 0 || box.left >= (boxes[index - 1]?.right ?? Infinity)), "Project links must not overlap");
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function development(page: Page): Promise<void> {
  await page.evaluate(() => { void playground.shell.submit("bun run dev"); });
  await page.waitForFunction(() => playground.previews.serves(5173), undefined, { timeout: 90_000 });
  const url = await page.evaluate(() => playground.previews.url(5173));
  const preview = await page.context().newPage();
  preview.on("console", message => events.push(message.text()));
  preview.on("pageerror", error => events.push(`pageerror: ${error.message}`));
  try {
    const connected = preview.waitForEvent("console", { predicate: message => message.text().includes("[HMR] connected"), timeout: 120_000 });
    const [response] = await Promise.all([preview.goto(url, { timeout: 120_000 }), connected]);
    assert.equal(response?.status(), 200);
    await preview.getByRole("heading", { name: "Next.js in your browser", exact: true }).waitFor({ timeout: 120_000 });
    await preview.getByRole("button", { name: "Count: 0", exact: true }).click();
    const documentIdentity = await preview.evaluate(() => performance.timeOrigin);
    const original = await page.evaluate(() => playground.editor.view.state.doc.toString());
    await setSource(page, original.replace("Next.js in your browser", "Next.js hot update works"));
    await preview.getByRole("heading", { name: "Next.js hot update works", exact: true }).waitFor({ timeout: 60_000 });
    await preview.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
    assert.equal(await preview.evaluate(() => performance.timeOrigin), documentIdentity);
    if (reports) await preview.screenshot({ path: join(reports, "next-playground-hmr.png") });
    await setSource(page, original);
    await preview.getByRole("heading", { name: "Next.js in your browser", exact: true }).waitFor({ timeout: 60_000 });
    await preview.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
    assert.equal(await preview.evaluate(() => performance.timeOrigin), documentIdentity);
    assert.deepEqual(events.filter(event => event.startsWith("pageerror:")), []);
    console.log("PASS Next dev render, editor save and revert, counter retained, no preview reload");
  } finally { await preview.close(); }
}

try {
  const url = new URL(process.env.NEXT_PLAYGROUND_URL ?? await task.serve());
  url.searchParams.set("template", "next");
  url.searchParams.set("engine", "browser");
  url.searchParams.set("prompt", "off");
  url.searchParams.set("mode", "memory");
  const browser = await task.launch(playwright.chromium);
  page = await (await browser.newContext()).newPage();
  page.on("pageerror", error => events.push(`pageerror: ${error.message}`));
  await page.goto(url.href);
  assert.match(await ready(page), /ready · Browser/);
  assert.equal(await page.evaluate(() => playground.editor.path), "/home/user/pages/index.tsx");
  await projectLinks(page);
  const installed = await run(page, "bun install", 180_000);
  assert.equal(installed.code, 0, installed.output);
  console.log("PASS Next dependencies installed in the guest");
  await development(page);
} finally {
  clearTimeout(deadline);
  try {
    if (reports && page && !page.isClosed()) {
      writeFileSync(join(reports, "next-playground-terminal.log"), await terminalText(page).catch(String));
      writeFileSync(join(reports, "next-playground-browser.log"), events.join("\n"));
    }
    if (page && !page.isClosed()) await stopForeground(page);
  } finally { await task.cleanup(); }
}
