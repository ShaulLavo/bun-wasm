import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const port = Number(process.env.SITE_SHELL_PORT);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "SITE_SHELL_PORT must be an explicit free port");
const root = resolve(import.meta.dir, "../../site/dist");
const output = process.env.SITE_SHELL_EVIDENCE;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let closing: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return closing ??= (async () => {
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally { server?.kill(); await server?.exited; }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 180000);

function screen() {
  const term = Reflect.get(globalThis, "playground").term;
  return Array.from({ length: term.buffer.active.length }, (_, index) => term.buffer.active.getLine(index).translateToString(true)).join("\n");
}
async function command(page: Page, text: string): Promise<void> {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
async function contains(page: Page, text: string): Promise<void> {
  await page.waitForFunction(text => Reflect.get(globalThis, "siteShellScreen")().includes(text), text, { timeout: 30000 });
}
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => !Reflect.get(globalThis, "playground").shell.running && !document.querySelector<HTMLButtonElement>("#run")?.disabled);
}
async function exercise(page: Page, engine: string) {
  await page.goto(`http://127.0.0.1:${port}/playground/?mode=memory&engine=${engine}`);
  await page.waitForFunction(() => !!Reflect.get(globalThis, "playground"));
  await page.evaluate(`globalThis.siteShellScreen = ${screen.toString()}`);
  await ready(page);
  const shared = await page.evaluate(async () => {
    const { runtime, fs } = Reflect.get(globalThis, "playground");
    return fs === runtime.filesystem && await runtime.processes() === await runtime.processes();
  });
  assert.equal(shared, true, "Editor and shell borrow one runtime filesystem and process service");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo unfinished draft");
  await page.evaluate(async () => {
    const { shell } = Reflect.get(globalThis, "playground");
    await shell.submit("bun -e 'process.exit(7)'");
    if (shell.lastExit !== 7) throw new Error(`Expected exit 7, got ${shell.lastExit}`);
  });
  await command(page, "bun -e 'console.log(\"TTY_\" + process.stdin.isTTY)'");
  await contains(page, "TTY_true");
  await ready(page);
  await command(page, "printf 'SHELL_%s\\n' ready; mkdir -p demo; cd demo; printf 'from shell\\n' > input.txt; cat input.txt; pwd");
  await contains(page, "SHELL_ready");
  await contains(page, "from shell\n");
  await contains(page, "/home/user/demo");
  await ready(page);
  await command(page, "bun repl");
  await contains(page, "Welcome to Bun");
  await command(page, ".help");
  await contains(page, ".exit");
  await command(page, "6 * 7");
  await contains(page, "42");
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "playground").shell.running), true, "REPL remains live while waiting for keyboard input");
  if (output) await page.screenshot({ path: `${output}/${engine}-repl.png`, fullPage: true });
  await command(page, ".exit");
  await ready(page);
  await command(page, "bun repl");
  await page.waitForFunction(() => Reflect.get(globalThis, "siteShellScreen")().split("Welcome to Bun").length === 3);
  await page.keyboard.press("Control+d");
  await ready(page);
  await command(page, "bun -e 'process.stdout.write(\"KEYBOARD_\"); process.stdin.once(\"data\", x => { console.log(\"RECEIVED:\" + x.toString().trim()); process.exit(0); });'");
  await contains(page, "KEYBOARD_");
  await command(page, "hello-from-keyboard");
  await contains(page, "RECEIVED:hello-from-keyboard");
  await ready(page);
  await command(page, "bun -e 'console.log(\"TICK_\" + \"READY\"); setInterval(() => {}, 1000)'");
  await contains(page, "TICK_READY");
  await page.keyboard.press("Control+c");
  await ready(page);
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "playground").shell.lastExit), 130);
  await command(page, "printf 'RECOVERED_%s\\n' yes");
  await contains(page, "RECOVERED_yes");
  await ready(page);
  await page.locator("#run").click();
  await contains(page, "Hello, world.");
  await ready(page);
  await command(page, "echo keyboarx");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("d");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /(?:^|\n)keyboard\n/.test(Reflect.get(globalThis, "siteShellScreen")()));
  await ready(page);
  const transcript = await page.evaluate(() => Reflect.get(globalThis, "siteShellScreen")());
  if (output) {
    await Bun.write(`${output}/${engine}-transcript.txt`, transcript);
    await page.screenshot({ path: `${output}/${engine}-keyboard-repl.png`, fullPage: true });
  }
  return { engine, ok: true, transcript };
}
async function reportFailure(page: Page, engine: string): Promise<void> {
  if (output) await page.screenshot({ path: `${output}/${engine}-failure.png`, fullPage: true });
  console.error(await page.evaluate(() => Reflect.get(globalThis, "siteShellScreen")?.() ?? document.body.innerText));
}
try {
  server = Bun.spawn([process.execPath, resolve(import.meta.dir, "../serve.ts")], { env: { ...process.env, ROOT: root, PORT: String(port) }, stdout: "pipe", stderr: "inherit" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/playground/`).then(response => response.ok, () => false)) break;
    await Bun.sleep(50);
  }
  browser = await (launching = chromium.launch({ headless: true }));
  for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ["browser"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("pageerror", error => console.error(`pageerror: ${error.message}`));
    try { console.log(JSON.stringify(await exercise(page, engine))); }
    catch (error) {
      await reportFailure(page, engine);
      throw error;
    } finally { await context.close(); }
  }
} finally {
  clearTimeout(deadline);
  await cleanup();
}
