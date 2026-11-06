// Run with: source env.sh && bun sandbox/tests/next-dev.ts
// NEXT_DEV_TEMPLATE=next-app checks App Router; the default checks Pages Router.
// Build sandbox/dist first. NEXT_DEV_URL uses an already running local/private playground.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Terminal } from "@xterm/xterm";
import type { Editor } from "../src/editor";
import { instrumentNextCompilers, profileNextWorkers } from "./next-profile";
import { observePreviewSockets } from "../../web/tests/next-framework-sockets";
import { playwright, session } from "../../web/tests/playground.mjs";

declare const sandbox: { editor: Editor; term?: Terminal };

const template = process.env.NEXT_DEV_TEMPLATE ?? "next";
assert.ok(template === "next" || template === "next-app", "Choose next or next-app");
const browserName = process.env.NEXT_DEV_BROWSER ?? "chromium";
assert.ok(browserName === "chromium" || browserName === "webkit" || browserName === "firefox", "Choose a Playwright browser");
assert.ok(!process.env.NEXT_DEV_PROFILE || browserName === "chromium", "Worker CPU profiling requires Chromium");
const heading = template === "next-app" ? "Next.js App Router" : "Next.js in your browser";
const updatedHeading = `${heading} hot update works`;
const editTimeout = template === "next-app" ? 60_000 : 30_000;
const task = session("bun-wasm-next-dev-");
const reports = process.env.NEXT_DEV_REPORTS;
if (reports) mkdirSync(reports, { recursive: true });
const events: string[] = [];
const timings: Record<string, number> = {};
const started = performance.now();
let page: import("playwright").Page | undefined;
let stopProfile: (() => Promise<void>) | undefined;
const deadline = setTimeout(() => { void task.cleanup().finally(() => process.exit(124)); }, template === "next-app" ? 360_000 : 240_000);

async function terminalText(): Promise<string> {
  if (!page || page.isClosed()) return "";
  return page.evaluate(() => {
    if (typeof sandbox === "undefined" || !sandbox.term) return "";
    const buffer = sandbox.term.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n");
  }).catch(error => `Terminal unavailable: ${String(error)}`);
}

try {
  const hosted = process.env.NEXT_DEV_URL;
  const local = hosted ? undefined : await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, {
    PORT: "0", ROOT: resolve(import.meta.dir, "../dist"),
  });
  const base = hosted ?? local?.[1];
  assert.ok(base, "The local server must report its URL");
  const url = new URL(base);
  url.searchParams.set("template", template);
  url.searchParams.set("engine", "browser");
  const browser = await task.launch(playwright[browserName]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (process.env.NEXT_DEV_PROFILE) await instrumentNextCompilers(context, template);
  page = await context.newPage();
  await observePreviewSockets(page);
  page.on("console", message => events.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", error => events.push(`pageerror: ${error.stack ?? error.message}`));
  page.on("requestfailed", request => events.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  await page.goto(url.href);
  console.log(`Opened ${url.href}`);
  const preview = page.frameLocator("#preview");
  await preview.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 180_000 });
  timings.render = Math.round(performance.now() - started);
  console.log(`Next rendered in ${timings.render} ms`);
  await preview.getByRole("button", { name: "Count: 0", exact: true }).click();
  await preview.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
  const frame = page.frames().find(frame => frame.url().includes("/__preview/"));
  assert.ok(frame, "Next must render inside the playground preview");
  await frame.waitForFunction(() => globalThis.nextFrameworkSocketEvents.some(event => event.type === "open" && event.url.includes("/_next/webpack-hmr")), undefined, { timeout: 30_000 });
  const documentIdentity = await frame.evaluate(() => performance.timeOrigin);
  const original = await page.evaluate(() => sandbox.editor.view.state.doc.toString());
  stopProfile = process.env.NEXT_DEV_PROFILE && reports ? await profileNextWorkers(browser, reports) : undefined;
  const editStarted = performance.now();
  await page.evaluate(text => sandbox.editor.setText(text), original.replace(heading, updatedHeading));
  await preview.getByRole("heading", { name: updatedHeading, exact: true }).waitFor({ timeout: editTimeout });
  timings.edit = Math.round(performance.now() - editStarted);
  await preview.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
  assert.equal(await frame.evaluate(() => performance.timeOrigin), documentIdentity, "A hot update must not reload the document");
  if (reports) await page.screenshot({ path: join(reports, "next-dev-edited.png") });
  const revertStarted = performance.now();
  await page.evaluate(text => sandbox.editor.setText(text), original);
  await preview.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: editTimeout });
  timings.revert = Math.round(performance.now() - revertStarted);
  await preview.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
  assert.equal(await frame.evaluate(() => performance.timeOrigin), documentIdentity);
  const errors = events.filter(event => event.startsWith("pageerror:"));
  assert.deepEqual(errors, []);
  if (reports) writeFileSync(join(reports, "next-dev-result.json"), JSON.stringify({ status: "pass", template, browser: browserName, timings }, null, 2));
  console.log(JSON.stringify({ status: "pass", template, browser: browserName, timings }));
} catch (error) {
  console.error(await terminalText());
  console.error(events.join("\n"));
  if (reports && page && !page.isClosed()) await page.screenshot({ path: join(reports, "next-dev-failure.png") }).catch(() => {});
  throw error;
} finally {
  clearTimeout(deadline);
  if (reports) {
    writeFileSync(join(reports, "next-dev-terminal.log"), await terminalText());
    writeFileSync(join(reports, "next-dev-browser.log"), events.join("\n"));
  }
  try { await stopProfile?.(); } finally { await task.cleanup(); }
}
