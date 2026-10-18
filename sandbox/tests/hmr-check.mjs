// Drives the sandbox in real browsers through the HMR checklist, for every engine:
//   1. the app renders in the preview; 2. clicking the counter changes state;
//   3. editing App.tsx text updates the preview and the count survives (Fast Refresh);
//   4. editing App.css restyles without a reload; 5. a syntax error shows the overlay, the next
//   good save clears it (and the count still survives); 6. switching the engine keeps the edits.
// Also checks a separate preview tab, the vanilla template's import.meta.hot.data, an initial
// build error after Restart, phone layouts, and terminal copy.
//
//   node sandbox/tests/hmr-check.mjs <url> [--engines browser,quickjs,jsc] [--browsers chromium,webkit] [--shots dir]
//
// PLAYWRIGHT=<path to playwright's index.mjs> when `playwright` isn't resolvable from here.

import { selectAndNavigate } from "./hmr-navigation.ts";
import { installHmrConnection, waitForHmrConnection, readHmrFailureState } from "./hmr-connection.ts";
import { checkPhoneUI } from "../../web/tests/phone-ui.mjs";
import { firstVisit } from "../../web/tests/first-visit.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:4173/";
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const engines = option("engines", "browser,quickjs,jsc").split(",");
const browsers = option("browsers", "chromium,webkit").split(",");
const shots = option("shots", null);
if (shots) mkdirSync(shots, { recursive: true });

const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium, webkit, devices } = pw.default ?? pw;

const STARTUP_MS = Number(process.env.STARTUP_MS ?? 180_000);
const STEP_MS = 20_000;
const NAVIGATION = { navigationTimeout: STARTUP_MS, actionTimeout: STEP_MS };

async function check(browserName, engine) {
  const tag = `${browserName}/${engine}`;
  const logs = [];
  let browser, context, visit, page, app;
  const shot = async (step) => shots && page && !page.isClosed() && (await page.screenshot({ path: join(shots, `${browserName}-${engine}-${step}.png`) }));
  const results = [];
  const step = async (name, fn) => {
    const started = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - started });
      console.log(`  ok   ${tag} ${name} (${Date.now() - started} ms)`);
    } catch (err) {
      results.push({ name, ok: false, error: String(err) });
      console.log(`  FAIL ${tag} ${name}: ${err instanceof Error ? err.stack ?? String(err) : String(err)}`);
      if (page && !page.isClosed()) console.log(`      state: ${JSON.stringify(await readHmrFailureState(page, () => visit?.diagnostics()))}`);
      await shot(`fail-${name.replace(/\W+/g, "-")}`).catch(error => console.log(`      failure screenshot: ${error}`));
      throw err;
    }
  };
  const setFile = async (path, edit) => {
    await waitForHmrConnection(page, "#preview");
    await page.evaluate(async ([path, edit]) => {
      const { editor, fs } = globalThis.sandbox;
      await editor.open(path);
      const text = new TextDecoder().decode(await fs.readFile(`/home/user/app/${path}`));
      editor.setText(edit.reduce((t, [from, to]) => t.replace(from, to), text));
    }, [path, edit]);
  };
  try {
    await step("0 setup", async () => {
      browser = await (browserName === "webkit" ? webkit : chromium).launch();
      context = await browser.newContext(browserName === "webkit" ? { ...devices["iPhone 15"] } : { viewport: { width: 1440, height: 900 } });
      await installHmrConnection(context);
      const url = new URL(base);
      url.searchParams.set("engine", engine);
      visit = await firstVisit(context, url.href);
      page = await context.newPage();
      page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
      page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
      page.on("requestfailed", (request) => logs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
      app = page.frameLocator("#preview");
    });
    await step("0 navigation", () => page.goto(visit.url, { waitUntil: "commit", timeout: STARTUP_MS }));
    await step("1 renders", async () => {
      await app.locator("button.counter").waitFor({ timeout: STARTUP_MS });
      await app.locator("h1", { hasText: "Hello from bun.wasm" }).waitFor({ timeout: STEP_MS });
      await visit.check(page, engine === "browser");
      await shot("1-rendered");
    });
    await step("2 counter", async () => {
      for (let i = 0; i < 3; i++) await app.locator("button.counter").click();
      await app.locator("button.counter", { hasText: "count is 3" }).waitFor({ timeout: STEP_MS });
    });
    await step("3 edit tsx keeps state", async () => {
      await setFile("src/App.tsx", [["Hello from bun.wasm", "Hello, hot reload"]]);
      await app.locator("h1", { hasText: "Hello, hot reload" }).waitFor({ timeout: STEP_MS });
      const count = await app.locator("button.counter").textContent();
      if (count !== "count is 3") throw new Error(`state lost: ${count}`);
      await shot("3-edited");
    });
    await step("4 edit css", async () => {
      await setFile("src/App.css", [["color: #fbf0df;", "color: rgb(244, 114, 182);"]]);
      await page.waitForFunction(
        () => {
          const f = Array.from(document.querySelectorAll("iframe"))[0]?.contentDocument;
          const h1 = f?.querySelector("h1");
          return h1 && getComputedStyle(h1).color === "rgb(244, 114, 182)";
        },
        null,
        { timeout: STEP_MS },
      );
      const count = await app.locator("button.counter").textContent();
      if (count !== "count is 3") throw new Error(`css update reloaded the page: ${count}`);
      await shot("4-css");
    });
    await step("5 syntax error overlay and recovery", async () => {
      await setFile("src/App.tsx", [["<h1>", "<h1 "]]);
      await app.locator("bun-hmr").waitFor({ state: "visible", timeout: STEP_MS });
      await shot("5-overlay");
      await setFile("src/App.tsx", [["<h1 ", "<h1>"], ["Hello, hot reload", "Fixed it"]]);
      await app.locator("h1", { hasText: "Fixed it" }).waitFor({ timeout: STEP_MS });
      await app.locator("bun-hmr").waitFor({ state: "hidden", timeout: STEP_MS });
      const count = await app.locator("button.counter").textContent();
      if (count !== "count is 3") throw new Error(`state lost after recovery: ${count}`);
      await shot("5-recovered");
    });
    await step("5b preview in its own tab, with hot reload", async () => {
      // The preview bar's localhost label links to the preview route, which works in any tab.
      const href = await page.locator("#preview-url").getAttribute("href");
      if (!href || !new URL(href, page.url()).pathname.includes("/__preview/")) throw new Error(`label link: ${href}`);
      const tab = await context.newPage();
      try {
        await tab.goto(new URL(href, page.url()).href, { waitUntil: "commit", timeout: STEP_MS });
        await tab.locator("h1", { hasText: "Fixed it" }).waitFor({ timeout: STEP_MS });
        await Promise.all([waitForHmrConnection(page, "#preview"), waitForHmrConnection(tab)]);
        const documentId = await tab.evaluate(() => {
          globalThis.__hmrDocumentId = crypto.randomUUID();
          return globalThis.__hmrDocumentId;
        });
        await setFile("src/App.tsx", [["Fixed it", "From another tab"]]);
        await tab.locator("h1", { hasText: "From another tab" }).waitFor({ timeout: STEP_MS });
        await app.locator("h1", { hasText: "From another tab" }).waitFor({ timeout: STEP_MS });
        if (await tab.evaluate(() => globalThis.__hmrDocumentId) !== documentId) throw new Error("Preview tab replaced its document instead of applying HMR");
        await setFile("src/App.tsx", [["From another tab", "Fixed it"]]);
        await app.locator("h1", { hasText: "Fixed it" }).waitFor({ timeout: STEP_MS });
      } finally {
        await tab.close();
      }
    });
    await step("5c vanilla template uses import.meta.hot", async () => {
      await selectAndNavigate(page, "#template", "vanilla", NAVIGATION);
      await app.locator("h1", { hasText: "Hello from vanilla TypeScript" }).waitFor({ timeout: STARTUP_MS });
      for (let i = 0; i < 2; i++) await app.locator("button.counter").click();
      await setFile("src/main.ts", [["Hello from vanilla TypeScript", "Vanilla hot update"]]);
      await app.locator("h1", { hasText: "Vanilla hot update" }).waitFor({ timeout: STEP_MS });
      const count = await app.locator("button.counter").textContent();
      if (count !== "count is 2") throw new Error(`import.meta.hot.data lost state: ${count}`);
      await setFile("src/App.css", [["color: #fbf0df;", "color: rgb(34, 197, 94);"]]);
      await page.waitForFunction(() => {
        const heading = document.querySelector("iframe")?.contentDocument?.querySelector("h1");
        return heading && getComputedStyle(heading).color === "rgb(34, 197, 94)";
      }, null, { timeout: STEP_MS });
      await setFile("src/main.ts", [["const root =", "const root: ="]]);
      await app.locator("bun-hmr").waitFor({ state: "visible", timeout: STEP_MS });
      await setFile("src/main.ts", [["const root: =", "const root ="]]);
      await app.locator("bun-hmr").waitFor({ state: "hidden", timeout: STEP_MS });
      await app.locator("button.counter", { hasText: "count is 2" }).waitFor({ timeout: STEP_MS });
      await shot("5c-vanilla");
      await selectAndNavigate(page, "#template", "react", NAVIGATION);
      await app.locator("h1", { hasText: "Fixed it" }).waitFor({ timeout: STARTUP_MS });
    });
    await step("6 engine switch keeps edits", async () => {
      const other = engine === "quickjs" ? "browser" : "quickjs";
      await selectAndNavigate(page, "#engine", other, NAVIGATION);
      if (new URL(page.url()).searchParams.get("engine") !== (other === "browser" ? null : other)) throw new Error(`not switched: ${page.url()}`);
      await app.locator("h1", { hasText: "Fixed it" }).waitFor({ timeout: STARTUP_MS });
      await shot("6-switched");
    });
    await step("6b initial build error overlay and recovery", async () => {
      await setFile("src/App.tsx", [["<h1>", "<h1 "]]);
      await app.locator("bun-hmr").waitFor({ state: "visible", timeout: STEP_MS });
      await Promise.all([
        page.waitForEvent("framenavigated", { predicate: (frame) => frame.parentFrame() === page.mainFrame(), timeout: STARTUP_MS }),
        page.locator("#restart").click({ timeout: STEP_MS }),
      ]);
      await app.locator("bun-hmr").waitFor({ state: "visible", timeout: STEP_MS });
      await setFile("src/App.tsx", [["<h1 ", "<h1>"]]);
      await app.locator("h1", { hasText: "Fixed it" }).waitFor({ timeout: STEP_MS });
      await app.locator("bun-hmr").waitFor({ state: "hidden", timeout: STEP_MS });
      await app.locator("button.counter", { hasText: "count is 0" }).waitFor({ timeout: STEP_MS });
    });
    await step("7 phone layout and terminal copy", () => checkPhoneUI(page, "sandbox", browserName === "chromium"));
  } catch {
    console.log(logs.slice(-15).map((l) => `      ${l}`).join("\n"));
  } finally {
    await step("8 cleanup", async () => {
      try { await browser?.close(); }
      finally { await visit?.close(); }
    }).catch(() => {});
  }
  return { browser: browserName, engine, results };
}

const summary = [];
for (const browserName of browsers) {
  for (const engine of engines) {
    console.log(`${browserName} / ${engine}`);
    summary.push(await check(browserName, engine));
  }
}
const failed = summary.filter((s) => s.results.some((r) => !r.ok));
console.log(failed.length ? `\n${failed.length} of ${summary.length} runs failed` : `\nall ${summary.length} runs passed`);
process.exit(failed.length ? 1 : 0);
