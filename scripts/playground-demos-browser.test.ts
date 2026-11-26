import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { ready, run, session, terminalText } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";
import { examples } from "../web/src/examples";

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
  test(`${browserName}: bun check demo reports TS2322 with a non-zero exit, then exits 0 after fixing the file`, () => withBrowser(browserName, bunCheckDemo));
  test(`${browserName}: two tabs never share demo databases or overwrite a peer's restored file`, () => withBrowser(browserName, twoTabs));
  test(`${browserName}: a returning visitor's unedited old examples are upgraded and edited ones kept`, () => withBrowser(browserName, returningVisitor));
  test(`${browserName}: Run cannot slip into a preparing demo, and Stop cancels it`, () => withBrowser(browserName, runStopRace));
  test(`${browserName}: Restart belongs to the launch's own process, and a failed preview stops spinning`, () => withBrowser(browserName, attributionAndFailure));
  test(`${browserName}: a second Stop kills a server that ignores Ctrl-C, and Stop at any moment leaves Run usable`, () => withBrowser(browserName, forcedStop));
}

type Shell = { shell: { submit(command: string): Promise<void> }; editor: { open(path: string): Promise<void> } };

async function writeHome(page: Page, files: Record<string, string>): Promise<void> {
  await page.evaluate(async files => {
    const { fs } = Reflect.get(globalThis, "playground") as unknown as PageApi & { fs: { flush(): Promise<void> } };
    for (const [name, text] of Object.entries(files)) await fs.writeFile(`/home/user/${name}`, text);
    // Durable before the page closes, as a visitor's earlier session would have left them.
    await fs.flush();
  }, files);
}

/** A workspace seeded before the demos keeps main's db.ts and files.ts (bun-wasm 7b25271e). */
const OLD_DB = 'import { Database } from "bun:sqlite";\nconst db = new Database("todos.sqlite");\ndb.run("CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT, done INTEGER)");\n';
const OLD_FILES = 'const path = "notes/hello.txt";\nawait Bun.write(path, "old");\n';

async function returningVisitor(browser: Browser, url: string): Promise<void> {
  const editedMath = `${examples["math.ts"]!}// edited by the visitor\n`;
  const context = await browser.newContext();
  try {
    const page = await open(context, url);
    await writeHome(page, { "db.ts": OLD_DB, "files.ts": OLD_FILES, "math.ts": editedMath });
    // The visitor comes back: the same tab loads the page again over that workspace.
    await page.reload();
    expect(await ready(page)).toContain("ready");
    await page.waitForFunction(async edited => {
      const { fs } = Reflect.get(globalThis, "playground") as unknown as PageApi;
      return new TextDecoder().decode(await fs.readFile("/home/user/math.ts")) === edited;
    }, editedMath, { timeout: HANG_MS });
    // The demos add their own new files; nothing of the visitor's is touched.
    expect(await runDemo(page, "sqlite", OUTPUT.sqlite!)).toContain("1 open todo(s)");
    expect(await readText(page, "/home/user/sqlite.ts")).toBe(examples["sqlite.ts"]!);
    expect(await runDemo(page, "test", OUTPUT.test!)).toContain("5 pass");
    expect((await run(page, "cd /tmp", 30_000)).code).toBe(0);
    expect(await runDemo(page, "file", OUTPUT.file!)).toContain("exists: true");
    expect(await readText(page, "/home/user/bun-file.ts")).toBe(examples["bun-file.ts"]!);
    expect(await readText(page, "/home/user/db.ts")).toBe(OLD_DB);
    expect(await readText(page, "/home/user/files.ts")).toBe(OLD_FILES);
    expect(await readText(page, "/home/user/math.ts")).toBe(editedMath);
    const files = await page.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as { fs: { listFiles(path: string): Promise<string[]> } }).fs.listFiles("/home/user"));
    expect(files.filter(path => path.endsWith(".sqlite"))).toEqual([]);
    expect(files).toContain("/home/user/notes/hello.txt");
  } finally {
    await context.close();
  }
}

async function runStopRace(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await open(context, url);
    await page.locator('.demo[data-demo="serve"]').click();
    await page.frameLocator(".preview-dock iframe").locator("h1", { hasText: "Hello from Bun.serve" }).waitFor({ timeout: HANG_MS });

    // Build's preparation stops the server, then waits on its write claim, held here.
    await page.evaluate(holdClaimsStore);
    await page.locator('.demo[data-demo="build"]').click();
    await page.locator(".preview-dock").waitFor({ state: "detached", timeout: HANG_MS });
    const before = await terminalText(page);
    // The server has reached its prompt; Run (button state and keyboard) must not slip in.
    expect(await page.locator("#run").getAttribute("data-state")).toBe("stop");
    await page.locator("#editor .cm-content").focus();
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(500);
    expect(await terminalText(page)).toBe(before);

    // Stop cancels the pending demo: after the claim is released, Build never runs.
    await page.locator("#run").click();
    await page.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run", undefined, { timeout: HANG_MS });
    await page.evaluate(() => (Reflect.get(globalThis, "releaseClaims") as () => void)());
    await page.waitForTimeout(3000);
    const after = await terminalText(page);
    expect(after).not.toContain("entry-point");
    expect(after.split("bun run serve.ts").length - 1).toBe(1);
    expect(await page.locator("#run").getAttribute("data-state")).toBe("run");

    // The machine is usable again: the next demo runs normally.
    expect(await runDemo(page, "build", OUTPUT.build!)).toContain("entry-point dist/math.js");
  } finally {
    await context.close();
  }
}

async function terminalIncludes(page: Page, text: string): Promise<void> {
  await page.waitForFunction(text => {
    const buffer = (Reflect.get(globalThis, "playground") as unknown as PageApi).term.buffer.active;
    for (let row = 0; row < buffer.length; row++) if (buffer.getLine(row)?.translateToString(true).includes(text)) return true;
    return false;
  }, text, { timeout: HANG_MS });
}

async function idleRun(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const run = document.querySelector<HTMLButtonElement>("#run");
    return run?.getAttribute("data-state") === "run" && !run.disabled;
  }, undefined, { timeout: HANG_MS });
}

async function forcedStop(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await open(context, url);
    await writeHome(page, {
      "stubborn.ts": "process.on('SIGINT', () => console.log('IGNORED' + '_SIGINT'));\nBun.serve({ port: 3004, fetch: () => new Response('<h1>stubborn</h1>', { headers: { 'content-type': 'text/html' } }) });\nconsole.log('STUBBORN' + '_UP');\n",
    });
    await page.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as Shell).editor.open("/home/user/stubborn.ts"));
    await page.locator("#run").click();
    await page.locator(".preview-dock iframe").waitFor({ timeout: HANG_MS });
    await terminalIncludes(page, "STUBBORN_UP");

    // The first Stop sends Ctrl-C, which the server handles and survives.
    await page.locator("#run").click();
    await terminalIncludes(page, "IGNORED_SIGINT");
    expect(await page.locator("#run").getAttribute("data-state")).toBe("stop");
    expect(await page.locator(".preview-dock").count()).toBe(1);

    // The second Stop kills its job: Run comes back and the preview closes with the server.
    await page.locator("#run").click();
    await idleRun(page);
    await page.locator(".preview-dock").waitFor({ state: "detached", timeout: HANG_MS });

    // Stop pressed at any point of a demo's start (preparing, `cd ~`, launched) leaves the
    // playground idle with Run enabled, never stuck disabled.
    for (const delay of [0, 5, 10, 20, 40, 80, 160]) {
      await page.locator('.demo[data-demo="test"]').click();
      await page.waitForTimeout(delay);
      if (await page.locator("#run").getAttribute("data-state") === "stop") await page.locator("#run").click();
      await idleRun(page);
    }
    expect(await runDemo(page, "test", OUTPUT.test!)).toContain("5 pass");
  } finally {
    await context.close();
  }
}

async function attributionAndFailure(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await open(context, url);
    await writeHome(page, {
      "late.ts": "await Bun.sleep(2500);\nBun.serve({ port: 3001, fetch: () => new Response('<h1>late</h1>', { headers: { 'content-type': 'text/html' } }) });\nconsole.log('LATE' + '_UP');\n",
      "wait.ts": "console.log('WAIT' + '_START');\nawait Bun.sleep(20000);\n",
      "slow.ts": "Bun.serve({ port: 3002, fetch: async () => { await Bun.sleep(60000); return new Response('slow'); } });\nconsole.log('SLOW' + '_UP');\n",
    });

    // A background server that starts listening while Run is active is not Run's server: it gets
    // its terminal line but no docked preview (and so no Restart).
    expect((await run(page, "bun run late.ts &", 30_000)).code).toBe(0);
    await page.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as Shell).editor.open("/home/user/wait.ts"));
    await page.locator("#run").click();
    await terminalIncludes(page, "LATE_UP");
    await terminalIncludes(page, "[preview] localhost:3001");
    expect(await page.locator("#run").getAttribute("data-state")).toBe("stop");
    expect(await page.locator(".preview-dock").count()).toBe(0);
    await page.locator("#run").click();
    await page.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run", undefined, { timeout: HANG_MS });
    expect((await run(page, "kill %1; wait; true", 30_000)).code).toBe(0);

    // A preview whose request fails says so instead of spinning forever.
    await page.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as Shell).editor.open("/home/user/slow.ts"));
    await page.locator("#run").click();
    const frameElement = await page.locator(".preview-dock iframe").elementHandle({ timeout: HANG_MS });
    const frame = await frameElement!.contentFrame();
    await frame!.waitForFunction(() => document.querySelector("[data-preview-loading]") !== null, undefined, { timeout: HANG_MS });
    // The loading page polls its status with the global fetch; make the next poll fail.
    await frame!.evaluate(() => { Reflect.set(globalThis, "fetch", () => Promise.reject(new Error("offline"))); });
    await page.locator(".preview-dock .preview-failed").waitFor({ timeout: HANG_MS });
    expect(await page.locator(".preview-dock .spinner").count()).toBe(0);
    // Stop interrupts the server; pressing again forces it, as its title says.
    await page.locator("#run").click();
    const stopped = () => page.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run", undefined, { timeout: 10_000 });
    await stopped().catch(async () => {
      await page.locator("#run").click();
      await page.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run", undefined, { timeout: HANG_MS });
    });
  } finally {
    await context.close();
  }
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

    // A server started from the terminal keeps its terminal link but opens no docked preview,
    // whose request it may not expect.
    const typedBaseline = (await terminalText(page)).length;
    void page.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as { shell: { submit(command: string): Promise<void> } }).shell.submit("bun run serve.ts"));
    await terminalIncludes(page, "Bun.serve is listening");
    await page.waitForFunction(start => {
      const buffer = (Reflect.get(globalThis, "playground") as unknown as PageApi).term.buffer.active;
      let text = "";
      for (let row = 0; row < buffer.length; row++) text += `${buffer.getLine(row)?.translateToString(true) ?? ""}\n`;
      return text.slice(start).includes("[preview] localhost:3000");
    }, typedBaseline, { timeout: HANG_MS });
    expect(await page.locator(".preview-dock").count()).toBe(0);

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
    expect(await readText(page, "/home/user/sqlite.ts")).toBe("console.log('VISITOR' + '_EDIT');\n");

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

async function bunCheckDemo(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await open(context, url);
    let toolsDownloads = 0;
    page.on("request", request => {
      if (request.url().includes("bun-tools.wasm")) toolsDownloads++;
    });

    // A visitor's ~/jsconfig.json (legacy decorators for bun run / bun test, and path aliases for
    // bun build) must behave the same before and after clicking the check demo: nothing at ~ may shadow it.
    await writeHome(page, {
      "jsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          experimentalDecorators: true,
          paths: { "@alias/*": ["./aliased/*"] },
        },
      }),
      "aliased/value.ts": "export const value = 42;\n",
      "visitor-decorator.ts": [
        "export {};",
        "let mode = 'none';",
        "function tag(_target: unknown, ctx?: { kind?: string }) { mode = ctx === undefined ? 'legacy' : String(ctx.kind); }",
        "@tag class Box {}",
        "void Box;",
        'console.log("DECORATOR:" + mode);',
      ].join("\n") + "\n",
      "visitor-decorator.test.ts": [
        'import { expect, test } from "bun:test";',
        "let mode = 'none';",
        "function tag(_target: unknown, ctx?: { kind?: string }) { mode = ctx === undefined ? 'legacy' : String(ctx.kind); }",
        "@tag class Box {}",
        "void Box;",
        'test("jsconfig legacy decorator", () => expect(mode).toBe("legacy"));',
      ].join("\n") + "\n",
      "visitor-alias.ts": 'import { value } from "@alias/value";\nconsole.log("ALIAS:" + value);\n',
    });
    const assertVisitorJsconfigWorks = async (outDir: string) => {
      const ran = await run(page, "bun run visitor-decorator.ts", 30_000);
      expect(ran.code, ran.output).toBe(0);
      expect(ran.output).toContain("DECORATOR:legacy");
      const tested = await run(page, "bun test visitor-decorator.test.ts", 30_000);
      expect(tested.code, tested.output).toBe(0);
      expect(tested.output).toContain("1 pass");
      const built = await run(page, `bun build visitor-alias.ts --outdir ${outDir}`, 30_000);
      expect(built.code, built.output).toBe(0);
    };
    await assertVisitorJsconfigWorks("alias-before");

    // Clicking the bun check demo opens check-demo/src/check.ts, downloads bun-tools.wasm once,
    // reports TS2322, and exits 1 without creating ~/tsconfig.json.
    const diagnostic = "src/check.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.";
    const failed = await runDemo(page, "check", [diagnostic]);
    expect(failed).toContain(diagnostic);
    expect(await page.evaluate(() => (Reflect.get(globalThis, "playground") as unknown as { editor: { path: string } }).editor.path)).toBe("/home/user/check-demo/src/check.ts");
    expect((await run(page, "echo $?", 30_000)).output.trim()).toBe("1");
    expect(toolsDownloads).toBe(1);
    expect(await page.evaluate(async () => (await (Reflect.get(globalThis, "playground") as unknown as { fs: { lookup(path: string): Promise<unknown> } }).fs.lookup("/home/user/tsconfig.json")) ?? null)).toBeNull();
    await assertVisitorJsconfigWorks("alias-after");

    // A visitor's own clean ~/tsconfig.json must stay untouched and must not override the demo's project.
    const visitorTsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["visitor-clean.ts"] });
    await writeHome(page, {
      "tsconfig.json": visitorTsconfig,
      "visitor-clean.ts": "export const ok: number = 1;\n",
    });
    const visitorCheck = await run(page, "bun check", 30_000);
    expect(visitorCheck.code, visitorCheck.output).toBe(0);
    expect(visitorCheck.output).toContain("No type errors");
    await page.locator('.demo[data-demo="check"]').click();
    await page.waitForFunction(expected => {
      const api = Reflect.get(globalThis, "playground") as unknown as PageApi;
      if (api.shell.running || document.querySelector("#run")?.getAttribute("data-state") !== "run") return false;
      const buffer = api.term.buffer.active;
      let text = "";
      for (let row = 0; row < buffer.length; row++) text += buffer.getLine(row)?.translateToString(true) ?? "";
      return text.includes(expected) && !text.includes("No type errors");
    }, diagnostic, { timeout: HANG_MS });
    expect((await run(page, "echo $?", 30_000)).output.trim()).toBe("1");
    expect(await readText(page, "/home/user/tsconfig.json")).toBe(visitorTsconfig);
    expect(toolsDownloads).toBe(1);

    // Direct `bun check --cwd check-demo` reports the same diagnostic and exits 1 without redownloading tools.
    const plain = await run(page, "bun check --cwd check-demo", 30_000);
    expect(plain.code, plain.output).toBe(1);
    expect(plain.output).toContain(diagnostic);
    expect(toolsDownloads).toBe(1);

    // Fixing check-demo/src/check.ts in the editor and rerunning the demo clears the error and exits 0.
    const fixed = "export const total: number = 3;\n";
    await setEditorText(page, fixed);
    const passed = await runDemo(page, "check", ["No type errors"]);
    expect(passed).not.toContain("TS2322");
    expect(await readText(page, "/home/user/check-demo/src/check.ts")).toBe(fixed);
    expect((await run(page, "echo $?", 30_000)).output.trim()).toBe("0");
    expect(toolsDownloads).toBe(1);

    // Pressing Run while check-demo/src/check.ts is open also runs bun check rather than bun run.
    await setEditorText(page, 'export const total: number = "four";\n');
    await page.locator("#run").click();
    const rerun = await waitForOutput(page, "check", [diagnostic]);
    expect(rerun).toContain(diagnostic);
    expect((await run(page, "echo $?", 30_000)).output.trim()).toBe("1");

    // Restoring a deleted check-demo/tsconfig.json keeps the visitor's fixed check-demo/src/check.ts and works from another cwd.
    await setEditorText(page, fixed);
    expect((await run(page, "rm check-demo/tsconfig.json && cd /tmp", 30_000)).code).toBe(0);
    await page.locator('.demo[data-demo="check"]').click();
    await page.waitForFunction(() => {
      const api = Reflect.get(globalThis, "playground") as unknown as PageApi;
      if (api.shell.running || document.querySelector("#run")?.getAttribute("data-state") !== "run") return false;
      const buffer = api.term.buffer.active;
      let text = "";
      for (let row = 0; row < buffer.length; row++) text += buffer.getLine(row)?.translateToString(true) ?? "";
      return text.includes("No type errors") && !text.includes("TS2322");
    }, undefined, { timeout: HANG_MS });
    expect((await run(page, "echo $?", 30_000)).output.trim()).toBe("0");
    expect(await readText(page, "/home/user/check-demo/src/check.ts")).toBe(fixed);
    expect(await readText(page, "/home/user/check-demo/tsconfig.json")).toBe(examples["check-demo/tsconfig.json"]!);
    expect(toolsDownloads).toBe(1);
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
