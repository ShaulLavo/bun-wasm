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

async function editSandboxFile(page: Page, marker: string): Promise<void> {
  await page.evaluate(async (text) => {
    const api = Reflect.get(globalThis, "sandbox");
    const current = api.editor.view.state.doc.toString();
    const updated = current.includes("Hello from vanilla TypeScript")
      ? current.replace("Hello from vanilla TypeScript", text)
      : current.replace(/<h1>[^<]*<\/h1>/, `<h1>${text}</h1>`);
    api.editor.setText(updated);
    await api.editor.flush(api.editor.path);
  }, marker);
}

async function clickPreviewCounter(page: Page, expectedAfter: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    () => Boolean(document.querySelector<HTMLIFrameElement>("#preview")?.contentDocument?.querySelector("button.counter")),
    null,
    { timeout },
  );
  await page.evaluate(() => {
    const btn = document.querySelector<HTMLIFrameElement>("#preview")?.contentDocument?.querySelector<HTMLButtonElement>("button.counter");
    if (!btn) throw new Error("Missing .counter button in preview frame");
    btn.click();
  });
  await waitForPreviewText(page, expectedAfter, timeout);
}

async function playgroundTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pg = Reflect.get(globalThis, "playground") as {
      term?: { buffer?: { active?: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } };
    } | undefined;
    const buf = pg?.term?.buffer?.active;
    if (!buf) return "";
    let text = "";
    for (let i = 0; i < buf.length; i++) text += (buf.getLine(i)?.translateToString(true) ?? "") + "\n";
    return text;
  });
}

async function runPlaygroundServer(page: Page, marker: string): Promise<string> {
  await page.evaluate(async (bodyText) => {
    const pg = Reflect.get(globalThis, "playground") as unknown as {
      fs: { writeFile(path: string, data: string): Promise<void>; flush(): Promise<void> };
    };
    await pg.fs.writeFile(
      `/home/user/srv-${bodyText}.ts`,
      `Bun.serve({ port: 3000, fetch: () => new Response(${JSON.stringify(bodyText)}) });\n`,
    );
    await pg.fs.flush();
  }, marker);
  const baseline = (await playgroundTerminalText(page)).length;
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(`bun run /home/user/srv-${marker}.ts`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (start) => {
      const pg = Reflect.get(globalThis, "playground") as {
        term?: { buffer?: { active?: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } };
      } | undefined;
      const buf = pg?.term?.buffer?.active;
      if (!buf) return false;
      let text = "";
      for (let i = 0; i < buf.length; i++) text += (buf.getLine(i)?.translateToString(true) ?? "") + "\n";
      return /\[preview\] http:\/\/[^\s]+\/__preview\/r\/pg-[^\s/]+\/3000\//.test(text.slice(start));
    },
    baseline,
    { timeout: 60_000 },
  );
  const terminal = (await playgroundTerminalText(page)).slice(baseline);
  const match = /\[preview\] (http:\/\/[^\s]+\/__preview\/r\/pg-[^\s/]+\/3000\/)/.exec(terminal);
  expect(match?.[1]).toBeTruthy();
  return match![1]!;
}

for (const browserName of browsers) {
  test(`${browserName}: two persistent Sandbox tabs attach, live-HMR both frames, fail over on owner reload/close, and isolate memory routes`, async () => {
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
          role: api.role(),
          src,
        };
      });
      expect(tab1Info.mode).toBe("fast");
      expect(tab1Info.persistent).toBe(true);
      expect(tab1Info.ownershipLost).toBe(false);
      expect(tab1Info.role).toBe("owner");
      expect(tab1Info.src).toContain("/__preview/r/ws-");

      // Open Tab 2 on the same persistent workspace: must attach (NO takeover!) and mirror preview.
      const tab2 = await context.newPage();
      tab2.on("pageerror", (e) => errors.push(`tab2: ${e.message}`));
      await navigateTestPage(tab2, `${origin}/sandbox/?template=vanilla`);
      await waitForSandboxReady(tab2);

      expect(await tab1.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);
      expect(await tab2.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);
      expect(await tab2.evaluate(() => Reflect.get(globalThis, "sandbox").role())).toBe("follower");

      // Increment the vanilla HMR counter in BOTH frames BEFORE editing to prove true live HMR (not a full reload).
      await Promise.all([
        clickPreviewCounter(tab1, "count is 1"),
        clickPreviewCounter(tab2, "count is 1"),
      ]);

      // Edit in Tab 1 -> synced live to Tab 2's clean editor buffer AND BOTH live frames via HMR BEFORE takeover!
      const marker1 = `multitab-hmr-${browserName}-${Date.now()}`;
      await editSandboxFile(tab1, marker1);
      await tab2.waitForFunction(
        (needle) => Reflect.get(globalThis, "sandbox")?.editor?.view?.state?.doc?.toString().includes(needle),
        marker1,
        { timeout: 30_000 },
      );
      await Promise.all([waitForPreviewText(tab1, marker1), waitForPreviewText(tab2, marker1)]);
      // Counter state must be preserved by import.meta.hot.data in BOTH frames.
      const [tab1Counter, tab2Counter] = await Promise.all([
        tab1.evaluate(() => document.querySelector<HTMLIFrameElement>("#preview")?.contentDocument?.querySelector("button.counter")?.textContent ?? ""),
        tab2.evaluate(() => document.querySelector<HTMLIFrameElement>("#preview")?.contentDocument?.querySelector("button.counter")?.textContent ?? ""),
      ]);
      expect(tab1Counter).toBe("count is 1");
      expect(tab2Counter).toBe("count is 1");

      // Reload Tab 1 (Owner reload failover): Tab 2 must explicitly take ownership, Tab 1 reattaches cleanly without ownershipLost.
      await tab1.reload();
      await tab2.waitForFunction(
        () => Reflect.get(globalThis, "sandbox")?.role?.() === "owner" && document.querySelector("#server-dot")?.getAttribute("data-state") === "up",
        null,
        { timeout: 120_000 },
      );
      await waitForSandboxReady(tab1);
      expect(await tab2.evaluate(() => Reflect.get(globalThis, "sandbox").role())).toBe("owner");
      expect(await tab1.evaluate(() => Reflect.get(globalThis, "sandbox").role())).toBe("follower");
      expect(await tab1.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);
      expect(await tab2.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);
      await Promise.all([waitForPreviewText(tab1, marker1), waitForPreviewText(tab2, marker1)]);

      // Close the current owner (Tab 2) -> surviving Tab 1 must become owner and serve a fresh edit!
      await tab2.close();
      await tab1.waitForFunction(
        () => {
          const api = Reflect.get(globalThis, "sandbox");
          return api?.role?.() === "owner" && document.querySelector("#server-dot")?.getAttribute("data-state") === "up";
        },
        null,
        { timeout: 120_000 },
      );
      await waitForPreviewText(tab1, marker1);
      const marker2 = `post-failover-${browserName}-${Date.now()}`;
      await editSandboxFile(tab1, marker2);
      await waitForPreviewText(tab1, marker2);

      // Verify true response-body isolation: two mode=memory tabs on the same port 5173 serve distinct bodies!
      const mem1 = await context.newPage();
      const mem2 = await context.newPage();
      await Promise.all([
        navigateTestPage(mem1, `${origin}/sandbox/?template=vanilla&mode=memory`),
        navigateTestPage(mem2, `${origin}/sandbox/?template=vanilla&mode=memory`),
      ]);
      await Promise.all([waitForSandboxReady(mem1), waitForSandboxReady(mem2)]);
      const memSrc1 = await mem1.locator("#preview").getAttribute("src");
      const memSrc2 = await mem2.locator("#preview").getAttribute("src");
      expect(memSrc1).toContain("/__preview/r/mem-");
      expect(memSrc2).toContain("/__preview/r/mem-");
      expect(memSrc1).not.toBe(memSrc2);

      const memMarker1 = `mem-one-${Date.now()}`;
      const memMarker2 = `mem-two-${Date.now()}`;
      await Promise.all([editSandboxFile(mem1, memMarker1), editSandboxFile(mem2, memMarker2)]);
      await Promise.all([waitForPreviewText(mem1, memMarker1), waitForPreviewText(mem2, memMarker2)]);
      const [body1, body2] = await Promise.all([
        mem1.evaluate(() => document.querySelector<HTMLIFrameElement>("#preview")?.contentDocument?.body?.textContent ?? ""),
        mem2.evaluate(() => document.querySelector<HTMLIFrameElement>("#preview")?.contentDocument?.body?.textContent ?? ""),
      ]);
      expect(body1).toContain(memMarker1);
      expect(body1).not.toContain(memMarker2);
      expect(body2).toContain(memMarker2);
      expect(body2).not.toContain(memMarker1);

      expect(errors).toEqual([]);
    });
  }, 360_000);

  test(`${browserName}: two persistent Playground tabs boot concurrently, sync edits, and isolate same-port preview bodies`, async () => {
    await withSite(browserName, async (browser, origin) => {
      const context = await browser.newContext();
      cleanups.push(() => context.close());

      const errors: string[] = [];
      const tab1 = await context.newPage();
      const tab2 = await context.newPage();
      tab1.on("pageerror", (e) => errors.push(`pg1: ${e.message}`));
      tab2.on("pageerror", (e) => errors.push(`pg2: ${e.message}`));

      // Concurrent startup of both persistent Playground tabs (CI browser-guest site serves Playground at "/").
      await Promise.all([
        navigateTestPage(tab1, `${origin}/`),
        navigateTestPage(tab2, `${origin}/`),
      ]);
      await Promise.all([
        tab1.waitForFunction(() => (Reflect.get(globalThis, "playground") as any)?.editor?.path === "/home/user/index.ts", null, { timeout: 60_000 }),
        tab2.waitForFunction(() => (Reflect.get(globalThis, "playground") as any)?.editor?.path === "/home/user/index.ts", null, { timeout: 60_000 }),
      ]);

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

      // Start two same-port (3000) servers with distinct response bodies and verify routed body isolation.
      const [url1, url2] = await Promise.all([
        runPlaygroundServer(tab1, `pg-tab1-${browserName}`),
        runPlaygroundServer(tab2, `pg-tab2-${browserName}`),
      ]);
      expect(url1).not.toBe(url2);
      const previewPage1 = await context.newPage();
      const previewPage2 = await context.newPage();
      await Promise.all([navigateTestPage(previewPage1, url1), navigateTestPage(previewPage2, url2)]);
      expect(await previewPage1.locator("body").innerText()).toContain(`pg-tab1-${browserName}`);
      expect(await previewPage2.locator("body").innerText()).toContain(`pg-tab2-${browserName}`);
      expect(errors).toEqual([]);
    });
  }, 240_000);
}
