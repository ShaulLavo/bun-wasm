import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { join, resolve } from "node:path";
import { verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

// Tests here start real processes and browsers. The limit only catches a hang.
setDefaultTimeout(240_000);

const requested = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
const exactBrowsers = process.env.BUN_WASM_STORAGE_EXACT_BROWSERS === "1";
const browsers = Array.from(
  new Set(requested.flatMap((name) => (!exactBrowsers && name === "chromium" ? ["chromium", "firefox"] : [name]))),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

async function withSite(
  browserName: string,
  run: (browser: Browser, siteOrigin: string) => Promise<void>,
): Promise<void> {
  const engine = { chromium, firefox, webkit }[browserName];
  if (!engine) throw new Error(`Unsupported browser ${browserName}`);

  const devUrl = process.env.BUN_WASM_STORAGE_DEVELOPMENT_URL;
  if (devUrl) {
    if (process.env.CI) throw new Error("CI must consume the verified browser-guest producer artifact");
    const browser = await engine.launch({ headless: true });
    cleanups.push(() => browser.close());
    await run(browser, new URL(devUrl).origin);
    return;
  }

  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (!provided) throw new Error("Provide BUN_WASM_BROWSER_SITE. This consumer never builds a guest or site.");
  const directory = resolve(provided);
  const before = await verifySite(directory);
  const task = session("bun-wasm-multitab-");
  const previousRoot = process.env.ROOT;
  cleanups.push(async () => {
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
    await task.cleanup();
  });
  process.env.ROOT = join(directory, "site");
  const served = await task.serve();
  const browser = await engine.launch({ headless: true });
  cleanups.push(() => browser.close());
  await run(browser, new URL(served).origin);
  const after = await verifySite(directory);
  expect(after).toEqual(before);
}

async function waitForSandboxReady(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = Reflect.get(globalThis, "sandbox");
      const status = document.querySelector("#status");
      if (status?.getAttribute("data-kind") === "error") {
        throw new Error(`Sandbox error: ${status.textContent}`);
      }
      return Boolean(api?.editor?.path) && document.querySelector("#server-dot")?.getAttribute("data-state") === "up";
    },
    null,
    { timeout },
  );
}

async function waitForPreviewText(page: Page, expected: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (needle) => {
      const frame = document.querySelector<HTMLIFrameElement>("#preview");
      try {
        const text = frame?.contentDocument?.body?.textContent ?? "";
        return text.includes(needle);
      } catch {
        return false;
      }
    },
    expected,
    { timeout },
  );
}

for (const browserName of browsers) {
  test(`${browserName}: two persistent Sandbox tabs attach, sync edits live, share preview, and fail over on owner close`, async () => {
    await withSite(browserName, async (browser, origin) => {
      const context = await browser.newContext();
      cleanups.push(() => context.close());

      const errors: string[] = [];
      const tab1 = await context.newPage();
      tab1.on("pageerror", (e) => errors.push(`tab1: ${e.message}`));
      await navigateTestPage(tab1, `${origin}/sandbox/?template=vanilla`);
      await waitForSandboxReady(tab1);

      // Verify persistent IndexedDB (not memory) and routed preview URL.
      const tab1Info = await tab1.evaluate(() => {
        const api = Reflect.get(globalThis, "sandbox");
        const src = document.querySelector<HTMLIFrameElement>("#preview")?.getAttribute("src") ?? "";
        return {
          mode: api.fs.vfs.mode,
          persistent: api.fs.vfs.persistent,
          ownershipLost: api.fs.ownershipLost,
          src,
        };
      });
      expect(tab1Info.mode).toBe("fast");
      expect(tab1Info.persistent).toBe(true);
      expect(tab1Info.ownershipLost).toBe(false);
      expect(tab1Info.src).toContain("/__preview/r/ws-");

      // Open Tab 2 on the same persistent workspace: must attach (NO takeover!) and mirror preview.
      const tab2 = await context.newPage();
      tab2.on("pageerror", (e) => errors.push(`tab2: ${e.message}`));
      await navigateTestPage(tab2, `${origin}/sandbox/?template=vanilla`);
      await waitForSandboxReady(tab2);

      expect(await tab1.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);
      expect(await tab2.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);

      // Edit in Tab 1 -> synced live to Tab 2's clean editor buffer AND both previews via HMR!
      const marker = `multitab-${browserName}-${Date.now()}`;
      await tab1.evaluate(async (text) => {
        const api = Reflect.get(globalThis, "sandbox");
        const current = api.editor.view.state.doc.toString();
        const updated = current.includes("Vite")
          ? current.replace("Vite", text)
          : `${current}\n// ${text}\ndocument.body.dataset.multitab = ${JSON.stringify(text)};\n`;
        api.editor.setText(updated);
        await api.editor.flush(api.editor.path);
      }, marker);

      await tab2.waitForFunction(
        (needle) => Reflect.get(globalThis, "sandbox")?.editor?.view?.state?.doc?.toString().includes(needle),
        marker,
        { timeout: 30_000 },
      );

      // Close Tab 1 (Owner) -> Tab 2 must automatically elect itself Owner and keep preview alive!
      await tab1.close();
      await tab2.waitForFunction(
        () => {
          const status = document.querySelector("#status")?.textContent ?? "";
          return status.includes("dev server ready") && document.querySelector("#server-dot")?.getAttribute("data-state") === "up";
        },
        null,
        { timeout: 120_000 },
      );
      await waitForPreviewText(tab2, marker);

      // Verify clean isolation: two mode=memory tabs do NOT share writes or preview routes.
      const mem1 = await context.newPage();
      const mem2 = await context.newPage();
      await navigateTestPage(mem1, `${origin}/sandbox/?template=vanilla&mode=memory`);
      await navigateTestPage(mem2, `${origin}/sandbox/?template=vanilla&mode=memory`);
      await waitForSandboxReady(mem1);
      await waitForSandboxReady(mem2);
      const memSrc1 = await mem1.locator("#preview").getAttribute("src");
      const memSrc2 = await mem2.locator("#preview").getAttribute("src");
      expect(memSrc1).toContain("/__preview/r/mem-");
      expect(memSrc2).toContain("/__preview/r/mem-");
      expect(memSrc1).not.toBe(memSrc2);

      expect(errors).toEqual([]);
    });
  }, 360_000);

  test(`${browserName}: two persistent Playground tabs attach and sync editor saves without takeover`, async () => {
    await withSite(browserName, async (browser, origin) => {
      const context = await browser.newContext();
      cleanups.push(() => context.close());

      const errors: string[] = [];
      const tab1 = await context.newPage();
      tab1.on("pageerror", (e) => errors.push(`pg1: ${e.message}`));
      await navigateTestPage(tab1, `${origin}/playground/`);
      await tab1.waitForFunction(() => (Reflect.get(globalThis, "playground") as any)?.editor?.path === "/home/user/index.ts", null, { timeout: 60_000 });

      const tab2 = await context.newPage();
      tab2.on("pageerror", (e) => errors.push(`pg2: ${e.message}`));
      await navigateTestPage(tab2, `${origin}/playground/`);
      await tab2.waitForFunction(() => (Reflect.get(globalThis, "playground") as any)?.editor?.path === "/home/user/index.ts", null, { timeout: 60_000 });

      expect(await tab1.evaluate(() => (Reflect.get(globalThis, "playground") as any).fs.ownershipLost)).toBe(false);
      expect(await tab2.evaluate(() => (Reflect.get(globalThis, "playground") as any).fs.ownershipLost)).toBe(false);

      const content = `console.log("pg-sync-${browserName}-${Date.now()}");`;
      await tab1.evaluate(async (text) => {
        const editor = (Reflect.get(globalThis, "playground") as any).editor;
        editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text } });
        await editor.save();
      }, content);

      await tab2.waitForFunction(
        (expected) => (Reflect.get(globalThis, "playground") as any)?.editor?.view?.state?.doc?.toString() === expected,
        content,
        { timeout: 30_000 },
      );
      expect(errors).toEqual([]);
    });
  }, 240_000);
}
