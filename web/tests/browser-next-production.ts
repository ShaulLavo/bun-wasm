import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Runtime } from "waffle";
import type { Previews } from "../src/preview";
import { templateFiles } from "../../sandbox/template-files";
import { playwright, ready, run, session, terminalText } from "./playground.mjs";
import { stopForeground } from "./foreground";
import { assertAppProductionBuildID, assertProductionBrowserEvents, finishProduction, productionTemplate } from "./next-production-controls";

declare const playground: {
  editor: { path: string; open(path: string): Promise<void> };
  fs: Runtime["filesystem"];
  previews: Previews;
  shell: { submit(command: string): Promise<void>; running: boolean; lastExit: number };
};
declare const productionServer: { finished: boolean; error: string | null };

const template = productionTemplate(process.env.NEXT_PRODUCTION_TEMPLATE);
const reports = process.env.NEXT_PRODUCTION_REPORTS;
if (reports) mkdirSync(reports, { recursive: true });
const task = session("bun-wasm-next-production-");
const events: string[] = [];
const stages: { operation: string; ms: number; code: number | null }[] = [];
const staticResponses: { url: string; status: number }[] = [];
let operation = "launch Chromium";
let failure: string | null = null;
let page: Page | undefined;
let preview: Page | undefined;
let buildID: string | null = null;
let browserVersion: string | undefined;
let cleanup = false;
const started = Date.now();

function report(name: string, value: string): void {
  if (reports) writeFileSync(join(reports, name), value);
}

function observe(target: Page, label: string): void {
  target.on("console", message => events.push(`${label} ${message.type()}: ${message.text()}`));
  target.on("pageerror", error => events.push(`${label} pageerror: ${error.stack ?? error.message}`));
  target.on("requestfailed", request => events.push(`${label} requestfailed: ${request.url()} ${request.failure()?.errorText}`));
}

async function command(target: Page, label: string, text: string, timeout: number): Promise<void> {
  operation = label;
  console.log(`START ${label}: ${text}`);
  const result = await run(target, text, timeout);
  stages.push({ operation: label, code: result.code, ms: result.ms });
  report(`${label}.log`, result.output);
  console.log(`END ${label}: exit=${result.code} ms=${Math.round(result.ms)}`);
  assert.equal(result.code, 0, `${label} failed: ${result.output}`);
}

async function readGuest(target: Page, path: string): Promise<string | null> {
  return target.evaluate(async path => {
    const bytes = await playground.fs.readFile(path);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, path);
}

async function start(target: Page): Promise<string> {
  operation = "next start listener on port 5173";
  await target.evaluate(() => {
    Object.assign(globalThis, { productionServer: { finished: false, error: null } });
    void playground.shell.submit("bun run start")
      .catch(error => { productionServer.error = String(error); })
      .finally(() => { productionServer.finished = true; });
  });
  await target.waitForFunction(() => productionServer.finished || playground.previews.serves(5173), undefined, { timeout: 120_000 });
  const state = await target.evaluate(() => ({ ...productionServer, running: playground.shell.running, exit: playground.shell.lastExit }));
  assert.equal(state.finished, false, `next start exited before listening: ${JSON.stringify(state)}\n${await terminalText(target)}`);
  assert.equal(state.running, true);
  operation = "production preview registration";
  assert.equal(await target.evaluate(() => playground.previews.ready), "ready");
  assert.equal(await target.evaluate(() => playground.previews.serves(5173)), true);
  return target.evaluate(() => playground.previews.url(5173));
}

async function compiledPage(target: Page, url: string, expectedBuildID: string): Promise<void> {
  operation = "next start compiled page HTTP response";
  const response = await target.goto(url, { timeout: 120_000 });
  assert.equal(response?.status(), 200);
  assert.match(response?.headers()["content-type"] ?? "", /text\/html/);
  const html = await response?.text();
  assert.ok(html);
  report("production.html", html);
  assert.doesNotMatch(html, /\/_next\/static\/development\/|\/_next\/webpack-hmr/);
  if (template.id === "next") {
    const data: unknown = await target.locator("#__NEXT_DATA__").evaluate(element => JSON.parse(element.textContent ?? "null"));
    assert.ok(data && typeof data === "object" && "buildId" in data);
    assert.equal(data.buildId, expectedBuildID, "Served HTML must use the guest's production BUILD_ID");
  } else {
    assert.equal(await target.locator("#__NEXT_DATA__").count(), 0, "App Router must not fall back to Pages HTML");
    const scripts = await target.locator("script:not([src])").allTextContents();
    assertAppProductionBuildID(scripts, expectedBuildID);
  }
  await target.getByRole("heading", { name: template.heading, exact: true }).waitFor({ timeout: 120_000 });
  operation = "production counter hydration";
  await target.getByRole("button", { name: "Count: 0", exact: true }).click();
  await target.getByRole("button", { name: "Count: 1", exact: true }).click();
  await target.getByRole("button", { name: "Count: 2", exact: true }).waitFor();
  assert.ok(staticResponses.some(response => /\.js(?:\?|$)/.test(response.url)), "Production JavaScript must load over the preview route");
  assert.deepEqual(staticResponses.filter(response => response.status !== 200), []);
  assertProductionBrowserEvents(events);
  assert.equal(events.some(event => event.includes("[HMR] connected")), false);
  if (reports) await target.screenshot({ path: join(reports, "production.png") });
}

async function execute(): Promise<void> {
  const url = new URL(process.env.NEXT_PLAYGROUND_URL ?? await task.serve());
  // The terminal playground supplies the shell; the source-only App fixture replaces its Pages seed below.
  url.searchParams.set("template", "next");
  url.searchParams.set("engine", "browser");
  url.searchParams.set("prompt", "off");
  url.searchParams.set("mode", "memory");
  const browser = await task.launch(playwright.chromium);
  browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  observe(page, "playground");
  operation = `${template.id} template startup`;
  await page.goto(url.href, { timeout: 120_000 });
  assert.match(await ready(page), /ready · Browser/);
  if (template.id === "next-app") {
    operation = "load source-only App Router template into terminal workspace";
    const files = await templateFiles(new URL("../../sandbox/template-next-app", import.meta.url).pathname);
    await page.evaluate(async files => {
      await playground.fs.remove("/home/user");
      await playground.fs.mkdirp("/home/user");
      for (const [path, text] of Object.entries(files)) await playground.fs.writeFile(`/home/user/${path}`, text);
      await playground.editor.open("/home/user/app/page.tsx");
      await playground.fs.flush();
    }, files);
    assert.equal(await readGuest(page, "/home/user/pages/index.tsx"), null, "App fixture must not retain a Pages route");
  }
  assert.equal(await page.evaluate(() => playground.editor.path), template.editorPath);
  assert.equal(await readGuest(page, "/home/user/.next/BUILD_ID"), null, "Fresh template must not contain a prebuilt application");
  report("package.json", await readGuest(page, "/home/user/package.json") ?? "missing");
  report("next.config.ts", await readGuest(page, "/home/user/next.config.ts") ?? "missing");
  await command(page, "install", "bun install", 180_000);
  await command(page, "build", "NEXT_TELEMETRY_DISABLED=1 bun run build", 600_000);
  operation = "production BUILD_ID written";
  const completedBuildID = await readGuest(page, "/home/user/.next/BUILD_ID");
  assert.ok(completedBuildID && completedBuildID.trim(), "next build exited zero without writing .next/BUILD_ID");
  buildID = completedBuildID.trim();
  const previewURL = await start(page);
  preview = await context.newPage();
  observe(preview, "preview");
  preview.on("response", response => {
    if (new URL(response.url()).pathname.includes("/_next/static/")) staticResponses.push({ url: response.url(), status: response.status() });
  });
  await compiledPage(preview, previewURL, completedBuildID.trim());
  operation = "production process remained alive";
  assert.equal(await page.evaluate(() => playground.shell.running && !productionServer.finished), true);
  console.log("PASS next build exited zero, BUILD_ID matches next start HTML, port 5173 serves compiled JavaScript, counter hydrated");
}

let closing: Promise<void> | undefined;
let deadlineReached = false;

function closeSession(): Promise<void> {
  return closing ??= task.cleanup().then(() => { cleanup = true; });
}

function reportResult(): void {
  report("browser.log", events.join("\n"));
  report("result.json", JSON.stringify({ template: template.id, operation, failure, stages, browserVersion, buildID, staticResponses, ms: Date.now() - started, cleanup, scratch: task.scratch }, null, 2));
}

function expired(scope: string): void {
  if (deadlineReached) return;
  deadlineReached = true;
  failure ??= `${scope} deadline during ${operation}`;
  process.exitCode = 124;
  const forced = setTimeout(() => {
    try { reportResult(); } finally { process.exit(124); }
  }, 5_000);
  void closeSession().catch(error => events.push(`cleanup error: ${String(error)}`)).finally(() => {
    clearTimeout(forced);
    reportResult();
    process.exit(124);
  });
}

const deadline = setTimeout(() => expired("Overall 15-minute"), 900_000);

try {
  await execute();
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`FAIL ${operation}: ${failure}`);
  process.exitCode = 1;
} finally {
  const teardownDeadline = setTimeout(() => expired("Teardown 15-second"), 15_000);
  const target = page;
  try {
    await finishProduction({
      readTerminal: () => target && !target.isClosed() ? terminalText(target) : Promise.resolve(""),
      writeTerminal: text => report("terminal.log", text),
      stopForeground: async () => {
        if (!target || target.isClosed()) return;
        await stopForeground(target);
        assert.equal(await target.evaluate(() => playground.shell.running), false);
      },
      close: closeSession,
    });
    assertProductionBrowserEvents(events);
  } catch (error) {
    events.push(`cleanup error: ${String(error)}`);
    failure ??= `Finalization failed: ${String(error)}`;
    process.exitCode = 1;
  } finally {
    clearTimeout(teardownDeadline);
    clearTimeout(deadline);
    reportResult();
  }
}
