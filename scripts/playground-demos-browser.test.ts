import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { ready, run, session, terminalText } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

// Real browsers and the real Bun guest. The limits only catch a hang.
setDefaultTimeout(400_000);
const HANG_MS = 120_000;

/** The parts of the page's `globalThis.playground` these checks read. */
type PageApi = {
  shell: { running: boolean };
  fs: { writeFile(path: string, text: string): Promise<void>; readFile(path: string): Promise<Uint8Array> };
  term: { buffer: { active: { length: number; getLine(row: number): { isWrapped: boolean; translateToString(trim: boolean): string } | undefined } } };
};

/** What each one-click demo must print, on the default persistent filesystem. */
const OUTPUT: Record<string, string[]> = {
  sqlite: ["run bun:sqlite in a browser", "1 open todo(s)"],
  test: ["5 pass", "0 fail"],
  build: ["entry-point dist/math.js", "minified math.js:"],
  shell: ["escaped: hello; rm -rf /", "words: 3", "exit code of a failed ls:"],
  file: ["exists: true", "runtime: \"bun.wasm\""],
};

type Scenario = (browser: Browser, url: string) => Promise<void>;

for (const browserName of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${browserName}: demos run in one click, keep edits, restore deleted files and survive reload`, () => withBrowser(browserName, oneTab));
  test(`${browserName}: two tabs never share demo databases or overwrite a peer's restored file`, () => withBrowser(browserName, twoTabs));
}

async function withBrowser(browserName: string, scenario: Scenario): Promise<void> {
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
    await scenario(await task.launch(type), url);
    expect(verifySite(directory)).toEqual(before);
  } finally {
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
    await task.cleanup();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

async function open(context: BrowserContext, url: string, query = ""): Promise<Page> {
  const page = await context.newPage();
  await navigateTestPage(page, `${url}?engine=browser&prompt=off${query}`);
  expect(await ready(page)).toContain("ready");
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".demo-bar .demo")).every(button => !button.disabled), undefined, { timeout: HANG_MS });
  return page;
}

/** Clicks a demo and returns its output once the expected lines are printed and the shell is idle. */
async function runDemo(page: Page, id: string, expected: readonly string[]): Promise<string> {
  await page.locator(`.demo[data-demo="${id}"]`).click();
  return waitForOutput(page, id, expected);
}

/** Fails with the terminal text if the demo never prints `expected` or never returns to an idle shell. */
async function waitForOutput(page: Page, id: string, expected: readonly string[]): Promise<string> {
  try {
    await page.waitForFunction(({ id, expected }) => {
      const api = Reflect.get(globalThis, "playground") as unknown as PageApi;
      if (document.querySelector(`.demo[data-demo="${id}"]`)?.getAttribute("aria-pressed") !== "true") return false;
      if (api.shell.running || document.querySelector("#run")?.getAttribute("data-state") !== "run") return false;
      const buffer = api.term.buffer.active;
      let text = "";
      for (let row = 0; row < buffer.length; row++) text += buffer.getLine(row)?.translateToString(true) ?? "";
      return expected.every(line => text.includes(line));
    }, { id, expected }, { timeout: HANG_MS });
  } catch (error) {
    throw new Error(`${id} did not finish with ${JSON.stringify(expected)}:\n${await terminalText(page)}`, { cause: error });
  }
  return terminalText(page);
}

async function readText(page: Page, path: string): Promise<string> {
  return page.evaluate(async path => new TextDecoder().decode(await (Reflect.get(globalThis, "playground") as unknown as PageApi).fs.readFile(path)), path);
}

async function setEditorText(page: Page, text: string): Promise<void> {
  await page.locator("#editor .cm-content").fill(text);
}

async function oneTab(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await open(context, url);

    // Bun.serve: the server's page appears in the docked preview, and its route answers.
    await page.locator('.demo[data-demo="serve"]').click();
    const frame = page.frameLocator(".preview-dock iframe");
    await frame.locator("h1", { hasText: "Hello from Bun.serve" }).waitFor({ timeout: HANG_MS });
    expect(await frame.locator("b").textContent()).toBe("1");
    await frame.locator("#hello").click();
    await frame.locator("#out", { hasText: "\"hello\": \"browser\"" }).waitFor({ timeout: HANG_MS });
    const served = await terminalText(page);
    expect(served).toContain("Bun.serve is listening on http://localhost:3000/");
    expect(served.split("[preview]").length - 1).toBe(1);
    expect(await page.locator("#run").getAttribute("data-state")).toBe("stop");
    const previewUrl = await page.locator(".preview-dock iframe").getAttribute("src");
    expect(await page.locator(".preview-dock a.control").getAttribute("href")).toBe(previewUrl);
    expect(await page.locator(".preview-dock a.control").getAttribute("target")).toBe("_blank");

    // Restart reruns the demo that started the server: a new server process answers again.
    await page.locator(".preview-dock button", { hasText: "Restart" }).click();
    await page.waitForFunction(() => (document.querySelector(".preview-dock iframe") as HTMLIFrameElement | null)?.contentDocument?.querySelector("h1") !== null && document.querySelector("#run")?.getAttribute("data-state") === "stop", undefined, { timeout: HANG_MS });
    await page.frameLocator(".preview-dock iframe").locator("h1", { hasText: "Hello from Bun.serve" }).waitFor({ timeout: HANG_MS });

    // Close hides the preview while the server keeps running; Stop ends it.
    await page.locator(".preview-dock button", { hasText: "Close" }).click();
    await page.locator(".preview-dock").waitFor({ state: "detached" });
    expect(await page.locator("#run").getAttribute("data-state")).toBe("stop");
    await page.locator("#run").click();
    await page.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run", undefined, { timeout: HANG_MS });

    // A server started from the terminal is previewed without a Restart it could not honour.
    void page.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as { shell: { submit(command: string): Promise<void> } }).shell.submit("bun run serve.ts"));
    await page.locator(".preview-dock iframe").waitFor({ timeout: HANG_MS });
    expect(await page.locator(".preview-dock button", { hasText: "Restart" }).count()).toBe(0);

    // Every other demo stops the running server first, then runs; the preview closes with it.
    for (const [id, lines] of Object.entries(OUTPUT)) {
      const output = await runDemo(page, id, lines);
      for (const line of lines) expect(output, `${id} output`).toContain(line);
    }
    await page.locator(".preview-dock").waitFor({ state: "detached" });
    expect(new URL(page.url()).searchParams.get("demo")).toBe("file");

    // A visitor's edit is kept and run, not replaced by the stock example.
    await page.locator('.demo[data-demo="sqlite"]').click();
    await waitForOutput(page, "sqlite", OUTPUT.sqlite!);
    await setEditorText(page, "console.log('VISITOR' + '_EDIT');\n");
    const edited = await runDemo(page, "sqlite", ["VISITOR_EDIT"]);
    expect(edited).toContain("VISITOR_EDIT");
    expect(await readText(page, "/home/user/db.ts")).toBe("console.log('VISITOR' + '_EDIT');\n");

    // A deleted helper file is restored; the demo runs from any working directory.
    expect((await run(page, "rm math.ts && cd /tmp", 30_000)).code).toBe(0);
    expect(await runDemo(page, "test", OUTPUT.test!)).toContain("5 pass");
    expect(await runDemo(page, "build", OUTPUT.build!)).toContain("entry-point dist/math.js");

    // Reload keeps the workspace and reruns the demo named in the address.
    await page.reload();
    expect(await ready(page)).toContain("ready");
    await waitForOutput(page, "build", OUTPUT.build!);
    const listed = await run(page, "ls ~ ~/dist", 30_000);
    expect(listed.code, listed.output).toBe(0);
    expect(listed.output).toContain("math.js");
    expect(listed.output).not.toMatch(/\.sqlite\b/);
  } finally {
    await context.close();
  }
}

async function twoTabs(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const first = await open(context, url);
    const second = await open(context, url);

    // Both tabs run the SQLite demo at once: each has its own in-memory database.
    const [a, b] = await Promise.all([runDemo(first, "sqlite", OUTPUT.sqlite!), runDemo(second, "sqlite", OUTPUT.sqlite!)]);
    for (const output of [a, b]) expect(output).toContain("1 open todo(s)");

    // Both tabs serve at once, each counting only its own visits.
    await Promise.all([first, second].map(page => page.locator('.demo[data-demo="serve"]').click()));
    for (const page of [first, second]) await page.frameLocator(".preview-dock iframe").locator("b", { hasText: "1" }).waitFor({ timeout: HANG_MS });
    await second.evaluate(() => (document.querySelector(".preview-dock iframe") as HTMLIFrameElement).contentWindow!.location.reload());
    await second.frameLocator(".preview-dock iframe").locator("b", { hasText: "2" }).waitFor({ timeout: HANG_MS });
    expect(await first.frameLocator(".preview-dock iframe").locator("b").textContent()).toBe("1");
    const files = await second.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as { fs: { listFiles(path: string): Promise<string[]> } }).fs.listFiles("/home/user"));
    expect(files.filter(path => path.endsWith(".sqlite"))).toEqual([]);

    // Restore race: the first tab's restore waits on its write claim while the second tab
    // writes the missing file. The restore must keep the peer's file.
    await first.locator("#run").click();
    await first.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run", undefined, { timeout: HANG_MS });
    expect((await run(first, "rm ~/build.ts", 30_000)).code).toBe(0);
    await second.evaluate(holdClaimsStore);
    await first.locator('.demo[data-demo="build"]').click();
    await first.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "stop", undefined, { timeout: HANG_MS });
    const peer = "console.log('PEER' + '_FILE');\n";
    await second.evaluate(text => (Reflect.get(globalThis, "playground") as unknown as PageApi).fs.writeFile("/home/user/build.ts", text), peer);
    await second.evaluate(() => (Reflect.get(globalThis, "releaseClaims") as () => void)());
    const output = await waitForOutput(first, "build", ["PEER_FILE"]);
    expect(output).toContain("PEER_FILE");
    expect(await readText(first, "/home/user/build.ts")).toBe(peer);
  } finally {
    await context.close();
  }
}

/** Holds a write transaction on the shared claims store, so a peer's next write claim waits. */
function holdClaimsStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bun-wasm-workspace-claims");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const store = db.transaction(["claims"], "readwrite").objectStore("claims");
      let released = false;
      Reflect.set(globalThis, "releaseClaims", () => { released = true; });
      const spin = () => {
        if (released) { db.close(); return; }
        store.get("hold").onsuccess = spin;
      };
      spin();
      resolve();
    };
  });
}
