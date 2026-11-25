import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { ready, run, session, terminalText } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

// Real browsers and the real Bun guest. The limit only catches a hang.
setDefaultTimeout(300_000);

/** The parts of the page's `globalThis.playground` these checks read. */
type PageApi = {
  shell: { running: boolean };
  term: { buffer: { active: { length: number; getLine(row: number): { isWrapped: boolean; translateToString(trim: boolean): string } | undefined } } };
};

/** What each one-click demo must print, on the default persistent filesystem. */
const OUTPUT: Record<string, string[]> = {
  sqlite: ["run bun:sqlite in a browser", "open todo(s)"],
  test: ["5 pass", "0 fail"],
  build: ["entry-point dist/math.js", "minified math.js:"],
  shell: ["escaped: hello; rm -rf /", "words: 3", "exit code of a failed ls:"],
  file: ["exists: true", "runtime: \"bun.wasm\""],
};

for (const browserName of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${browserName}: playground demos run in one click, serve a live preview and survive reload`, async () => {
    if (browserName !== "chromium" && browserName !== "webkit") throw new Error(`Unsupported browser ${browserName}`);
    const type = browserName === "chromium" ? chromium : webkit;
    // Development: an already served playground build (for example web/serve.ts with ROOT=<dist>).
    const devUrl = process.env.BUN_WASM_STORAGE_DEVELOPMENT_URL;
    if (devUrl) {
      if (process.env.CI) throw new Error("CI must consume the verified browser-guest producer artifact");
      const browser = await type.launch();
      try { await scenario(browser, devUrl); } finally { await browser.close(); }
      return;
    }
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    if (process.env.CI && !provided) throw new Error("CI must provide the existing browser-guest site");
    const scratch = provided ? undefined : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-demos-site-"));
    const directory = provided ? resolve(provided) : scratch!;
    const previousRoot = process.env.ROOT;
    const task = session("bun-wasm-demos-browser-");
    try {
      const before = provided ? verifySite(directory) : buildSite(directory);
      process.env.ROOT = join(directory, "site");
      const url = await task.serve();
      const browser = await task.launch(type);
      await scenario(browser, url);
      expect(verifySite(directory)).toEqual(before);
    } finally {
      if (previousRoot === undefined) delete process.env.ROOT;
      else process.env.ROOT = previousRoot;
      await task.cleanup();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  });
}

async function demosEnabled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".demo-bar .demo"));
    return buttons.length > 0 && buttons.every(button => !button.disabled);
  }, undefined, { timeout: 120_000 });
}

/** Clicks a demo, waits for its expected output and an idle shell, and returns the new output. */
async function runDemo(page: Page, id: string, expected: readonly string[]): Promise<string> {
  const before = (await terminalText(page)).length;
  await page.locator(`.demo[data-demo="${id}"]`).click();
  await page.waitForFunction(({ id, before, expected }) => {
    const api = Reflect.get(globalThis, "playground") as unknown as PageApi;
    if (document.querySelector(`.demo[data-demo="${id}"]`)?.getAttribute("aria-pressed") !== "true") return false;
    if (api.shell.running || document.querySelector<HTMLButtonElement>("#run")?.disabled) return false;
    const buffer = api.term.buffer.active;
    let text = "";
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      text += (line?.isWrapped ? "" : "\n") + (line?.translateToString(true) ?? "");
    }
    const output = text.slice(before);
    return expected.every(line => output.includes(line));
  }, { id, before, expected }, { timeout: 120_000 }).catch(() => {});
  return (await terminalText(page)).slice(before);
}

async function scenario(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await navigateTestPage(page, `${url}?engine=browser&prompt=off`);
    expect(await ready(page)).toContain("ready");
    await demosEnabled(page);

    // Bun.serve: the server's page appears in the docked preview, and its route answers.
    await page.locator('.demo[data-demo="serve"]').click();
    const frame = page.frameLocator(".preview-dock iframe");
    await frame.locator("h1", { hasText: "Hello from Bun.serve" }).waitFor({ timeout: 120_000 });
    await expect(frame.locator("b").textContent()).resolves.toBe("1");
    await frame.locator("#hello").click();
    await frame.locator("#out", { hasText: "\"hello\": \"browser\"" }).waitFor({ timeout: 60_000 });
    const served = await terminalText(page);
    expect(served).toContain("Bun.serve is listening on http://localhost:3000/");
    expect(served.split("[preview]").length - 1).toBe(1);

    // Restart stops the server and starts it again; the sqlite counter persists in the file.
    await page.locator(".preview-dock button", { hasText: "Restart" }).click();
    await page.frameLocator(".preview-dock iframe").locator("b", { hasText: "2" }).waitFor({ timeout: 120_000 });

    // Another demo stops the running server first, then runs; the preview closes with the server.
    for (const [id, lines] of Object.entries(OUTPUT)) {
      const output = await runDemo(page, id, lines);
      for (const line of lines) expect(output, `${id} output`).toContain(line);
    }
    await page.locator(".preview-dock").waitFor({ state: "detached" });
    expect(new URL(page.url()).searchParams.get("demo")).toBe("file");

    // A deleted helper file is restored by its demo; other edits stay.
    const removed = await run(page, "rm math.ts", 30_000);
    expect(removed.code, removed.output).toBe(0);
    const tested = await runDemo(page, "test", OUTPUT.test!);
    expect(tested).toContain("5 pass");

    // Reload keeps the workspace and reruns the demo named in the address.
    await page.reload();
    expect(await ready(page)).toContain("ready");
    await page.waitForFunction(() => {
      const buffer = (Reflect.get(globalThis, "playground") as unknown as PageApi | undefined)?.term.buffer.active;
      if (!buffer) return false;
      for (let row = 0; row < buffer.length; row++) if (buffer.getLine(row)?.translateToString(true).includes("5 pass")) return true;
      return false;
    }, undefined, { timeout: 120_000 });
    await expect(page.locator(".demo[aria-pressed=true]").getAttribute("data-demo")).resolves.toBe("test");
    const listed = await run(page, "ls dist visits.sqlite", 30_000);
    expect(listed.code, listed.output).toBe(0);
    expect(listed.output).toContain("math.js");
  } finally {
    await context.close();
  }
}
