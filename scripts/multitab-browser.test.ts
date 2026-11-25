import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { join, resolve } from "node:path";
import { verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";
import { isCancelledLoadingStatusPoll } from "./preview-loading-noise";

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

function collectPageErrors(page: Page, label: string, errors: string[]): void {
  page.on("pageerror", (error) => {
    if (isCancelledLoadingStatusPoll(error.message)) return;
    errors.push(`${label}: ${error.message}`);
  });
}

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
  try {
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
  } catch (error) {
    const diag = await page.evaluate(() => {
      const api = Reflect.get(globalThis, "sandbox");
      return {
        role: api?.role?.() ?? null,
        editorPath: api?.editor?.path ?? null,
        serverDot: document.querySelector("#server-dot")?.getAttribute("data-state") ?? null,
        previewUrl: document.querySelector("#preview-url")?.textContent ?? null,
        status: document.querySelector("#status")?.textContent ?? null,
        fsStatus: api?.fs?.state?.status ?? null,
      };
    }).catch(() => null);
    throw new Error(`${String(error)} | sandboxDiag=${JSON.stringify(diag)}`);
  }
}

/** Role, status and Web Locks of a Sandbox tab, attached to a failed wait so a hang names its stage. */
async function sandboxDiagnostics(page: Page): Promise<unknown> {
  if (page.isClosed()) return "closed";
  return page.evaluate(async () => {
    const api = Reflect.get(globalThis, "sandbox");
    const locks = await navigator.locks.query();
    const names = (list: readonly LockInfo[] | undefined) => (list ?? []).map((lock) => `${lock.mode === "shared" ? "s" : "x"}:${lock.name}`);
    return {
      role: api?.role?.() ?? null,
      status: document.querySelector("#status")?.textContent ?? null,
      serverDot: document.querySelector("#server-dot")?.getAttribute("data-state") ?? null,
      previewSrc: document.querySelector("#preview")?.getAttribute("src") ?? null,
      ownershipLost: api?.fs?.ownershipLost ?? null,
      held: names(locks.held),
      pending: names(locks.pending),
    };
  }).catch((error: unknown) => `unavailable: ${String(error)}`);
}

async function waitForSandboxRole(page: Page, role: "owner" | "follower", peers: Record<string, Page>, timeout = 120_000): Promise<void> {
  try {
    await page.waitForFunction(
      (expected) => Reflect.get(globalThis, "sandbox")?.role?.() === expected && document.querySelector("#server-dot")?.getAttribute("data-state") === "up",
      role,
      { timeout },
    );
  } catch (error) {
    const diagnostics: Record<string, unknown> = {};
    for (const [name, peer] of Object.entries(peers)) diagnostics[name] = await sandboxDiagnostics(peer);
    throw new Error(`${String(error)} | waiting for ${role} | ${JSON.stringify(diagnostics)}`);
  }
}

/** Waits until exactly one tab owns the dev server (up) and every other tab follows it (up). */
async function waitForSingleOwner(tabs: Record<string, Page>, timeout = 120_000): Promise<{ owner: Page; follower: Page }> {
  const pages = Object.values(tabs);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const states = await Promise.all(pages.map((page) => page.evaluate(() =>
      `${Reflect.get(globalThis, "sandbox")?.role?.() ?? ""}|${document.querySelector("#server-dot")?.getAttribute("data-state") ?? ""}`,
    ).catch(() => "")));
    const owners = pages.filter((_, index) => states[index] === "owner|up");
    const followers = pages.filter((_, index) => states[index] === "follower|up");
    if (owners.length === 1 && followers.length === pages.length - 1) return { owner: owners[0]!, follower: followers[0]! };
    await Bun.sleep(250);
  }
  const diagnostics: Record<string, unknown> = {};
  for (const [name, page] of Object.entries(tabs)) diagnostics[name] = await sandboxDiagnostics(page);
  throw new Error(`No single dev server owner within ${timeout} ms | ${JSON.stringify(diagnostics)}`);
}

async function playgroundDiagnostics(page: Page): Promise<unknown> {
  if (page.isClosed()) return "closed";
  return page.evaluate(async () => {
    const pg = Reflect.get(globalThis, "playground") as { editor?: { path?: string }; fs?: { ownershipLost?: boolean } } | undefined;
    const locks = await navigator.locks.query();
    const names = (list: readonly LockInfo[] | undefined) => (list ?? []).map((lock) => `${lock.mode === "shared" ? "s" : "x"}:${lock.name}`);
    const status = document.querySelector("#status");
    return {
      editorPath: pg?.editor?.path ?? null,
      status: status?.textContent ?? null,
      statusKind: status?.getAttribute("data-kind") ?? null,
      ownershipLost: pg?.fs?.ownershipLost ?? null,
      held: names(locks.held),
      pending: names(locks.pending),
    };
  }).catch((error: unknown) => `unavailable: ${String(error)}`);
}

async function waitForPlaygroundReady(page: Page, peers: Record<string, Page>, timeout = 60_000): Promise<void> {
  try {
    await page.waitForFunction(
      () => (Reflect.get(globalThis, "playground") as { editor?: { path?: string } } | undefined)?.editor?.path === "/home/user/index.ts"
        && document.querySelector("#status")?.getAttribute("data-kind") === "ok",
      null,
      { timeout },
    );
  } catch (error) {
    const diagnostics: Record<string, unknown> = {};
    for (const [name, peer] of Object.entries(peers)) diagnostics[name] = await playgroundDiagnostics(peer);
    throw new Error(`${String(error)} | waiting for Playground | ${JSON.stringify(diagnostics)}`);
  }
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
      term?: { buffer?: { active?: { length: number; getLine(i: number): { isWrapped?: boolean; translateToString(trim: boolean): string } | undefined } } };
    } | undefined;
    const buf = pg?.term?.buffer?.active;
    if (!buf) return "";
    let text = "";
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      if (i > 0 && !line.isWrapped) text += "\n";
      const nextWrapped = buf.getLine(i + 1)?.isWrapped === true;
      text += line.translateToString(!nextWrapped);
    }
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
  await page.evaluate((file) => {
    const pg = Reflect.get(globalThis, "playground") as unknown as { shell: { submit(command: string): Promise<void> } };
    void pg.shell.submit(`bun run ${file}`);
  }, `/home/user/srv-${marker}.ts`);
  try {
    await page.waitForFunction(
      (start) => {
        const pg = Reflect.get(globalThis, "playground") as {
          term?: { buffer?: { active?: { length: number; getLine(i: number): { isWrapped?: boolean; translateToString(trim: boolean): string } | undefined } } };
        } | undefined;
        const buf = pg?.term?.buffer?.active;
        if (!buf) return false;
        let text = "";
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (!line) continue;
          if (i > 0 && !line.isWrapped) text += "\n";
          text += line.translateToString(buf.getLine(i + 1)?.isWrapped !== true);
        }
        // The terminal names the server `localhost:3000`; its link targets the routed preview URL.
        return /\[preview\] localhost:3000\b/.test(text.slice(start));
      },
      baseline,
      { timeout: 60_000 },
    );
  } catch (error) {
    const terminal = await playgroundTerminalText(page).catch(() => "");
    throw new Error(`${String(error)} | baseline ${baseline} | terminal tail: ${JSON.stringify(terminal.slice(-1500))}`);
  }
  // The link's target is the tab's own routed preview, the same URL the terminal link opens.
  const url = await page.evaluate(() => {
    const pg = Reflect.get(globalThis, "playground") as unknown as { previews: { serves(port: number): boolean; url(port: number): string } };
    return pg.previews.serves(3000) ? pg.previews.url(3000) : "";
  });
  expect(url).toMatch(/^http:\/\/[^\s]+\/__preview\/r\/pg-[^\s/]+\/3000\/$/);
  return url;
}

for (const browserName of browsers) {
  test(`${browserName}: two persistent Sandbox tabs attach, live-HMR both frames, fail over on owner reload/close, and isolate memory routes`, async () => {
    await withSite(browserName, async (browser, origin) => {
      const context = await browser.newContext();
      cleanups.push(() => context.close());

      const errors: string[] = [];
      const tab1 = await context.newPage();
      collectPageErrors(tab1, "tab1", errors);
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
      collectPageErrors(tab2, "tab2", errors);
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

      // Reload the owner (Tab 1). Its old document keeps its locks until the reloaded document commits,
      // and the reloaded tab boots from the cached engine at once, so Tab 2 and the reloaded Tab 1 race
      // for ownership. Either may win: exactly one owner with the dev server up, the other attached
      // as a follower without ownershipLost, and both previews still live.
      await tab1.reload();
      const { owner, follower } = await waitForSingleOwner({ tab1, tab2 });
      await waitForSandboxReady(tab1);
      expect(await tab1.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);
      expect(await tab2.evaluate(() => Reflect.get(globalThis, "sandbox").fs.ownershipLost)).toBe(false);
      await Promise.all([waitForPreviewText(tab1, marker1), waitForPreviewText(tab2, marker1)]);

      // Close the current owner -> the surviving tab must become owner and serve a fresh edit!
      await owner.close();
      await waitForSandboxRole(follower, "owner", { follower });
      await waitForPreviewText(follower, marker1);
      const marker2 = `post-failover-${browserName}-${Date.now()}`;
      await editSandboxFile(follower, marker2);
      await waitForPreviewText(follower, marker2);

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
      collectPageErrors(tab1, "pg1", errors);
      collectPageErrors(tab2, "pg2", errors);

      // Concurrent startup of both persistent Playground tabs (CI browser-guest site serves Playground at "/").
      await Promise.all([
        navigateTestPage(tab1, `${origin}/`),
        navigateTestPage(tab2, `${origin}/`),
      ]);
      await Promise.all([waitForPlaygroundReady(tab1, { tab1, tab2 }), waitForPlaygroundReady(tab2, { tab1, tab2 })]);

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
      const pgMarker1 = `pg-tab1-${browserName}`;
      const pgMarker2 = `pg-tab2-${browserName}`;
      await Promise.all([
        previewPage1.waitForFunction((needle) => (document.body?.innerText ?? "").includes(needle), pgMarker1, { timeout: 30_000 }),
        previewPage2.waitForFunction((needle) => (document.body?.innerText ?? "").includes(needle), pgMarker2, { timeout: 30_000 }),
      ]);
      const [pgBody1, pgBody2] = await Promise.all([
        previewPage1.locator("body").innerText(),
        previewPage2.locator("body").innerText(),
      ]);
      expect(pgBody1).toContain(pgMarker1);
      expect(pgBody1).not.toContain(pgMarker2);
      expect(pgBody2).toContain(pgMarker2);
      expect(pgBody2).not.toContain(pgMarker1);
      expect(errors).toEqual([]);
    });
  }, 240_000);
}
