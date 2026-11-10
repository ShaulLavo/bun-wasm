import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";

const task = session("bun-wasm-quickjs-stack-");
const probe = readFileSync(new URL("../../tests/stack-depth.js", import.meta.url), "utf8");
const modes = ["plain", "getter", "proxy", "json", "jsonplain", "jsonparse", "reviver", "parse", "block", "arrow", "unary",
  "power", "ternary", "statement", "regexpnc", "lookahead", "proxychain", "isarray", "bound", "join", "flat", "tostring", "async", "promise", "console"];
const budget = process.env.QUICKJS_STACK_KIB;
assert.ok(budget === undefined || /^[1-9][0-9]*$/.test(budget));
const args = process.argv.slice(2);
const browsers = args.length ? args : ["firefox", "chromium"];
const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(124)); }, 600_000);

async function execute(page: Page, mode: string, depth: number): Promise<string> {
  const env = budget ? `BUN_WASM_STACK_KIB=${budget} ` : "";
  const result = await run(page, `${env}bun run depth.js ${mode} ${depth}`, 90_000);
  assert.equal(result.code, 0, `${mode}: ${JSON.stringify(result)}`);
  assert.match(result.output, /continued/, `${mode}: guest must recover after recursion`);
  return result.output;
}

async function opened(browser: Browser, url: string, check: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${url}?engine=quickjs&prompt=off&mode=memory`);
    await ready(page, 90_000);
    await writeFile(page, "/home/user/depth.js", probe);
    await check(page);
  } finally { await context.close(); }
}

async function capacity(browser: Browser, url: string): Promise<void> {
  await opened(browser, url, async page => {
    assert.match(await execute(page, "plain", 200), /^completed plain 200$/m);
  });
}

async function nativeCapacity(browser: Browser, url: string): Promise<void> {
  await opened(browser, url, async page => {
    const fixture = new URL("../../tests/fixtures/stack-native-call/", import.meta.url);
    for (const name of ["control.ts", "semantics.ts"]) {
      await writeFile(page, `/home/user/${name}`, readFileSync(new URL(name, fixture), "utf8"));
    }
    const result = await run(page, `BUN_WASM_STACK_KIB=${budget ?? "32"} bun run control.ts`, 90_000);
    assert.equal(result.code, 0, `native call capacity: ${JSON.stringify(result)}`);
    assert.equal(result.output.trim(), readFileSync(new URL("expected.txt", fixture), "utf8").trim());
  });
}

async function overflow(browser: Browser, url: string, mode: string): Promise<void> {
  await opened(browser, url, async page => {
    const output = await execute(page, mode, mode === "bound" ? 2000 : 200000);
    const expected = (mode === "console" || mode === "isarray") ? /^completed (?:console|isarray) /m : /^caught \w+ (?:RangeError|SyntaxError)/m;
    assert.match(output, expected, `${mode}: recursion must throw, not trap`);
  });
}

async function checkBrowser(name: string, url: string): Promise<void> {
  assert.ok(name === "firefox" || name === "chromium" || name === "webkit");
  const browser: Browser = await task.launch(playwright[name]);
  try {
    if (name !== "webkit") {
      await capacity(browser, url);
      console.log(`PASS ${name}/quickjs budget=${budget ?? "default"} plain 200 completes`);
    }
    await nativeCapacity(browser, url);
    console.log(`PASS ${name}/quickjs budget=${budget ?? "32"} native calls and recovery`);
    for (const mode of modes) {
      await overflow(browser, url, mode);
      console.log(`PASS ${name}/quickjs budget=${budget ?? "default"} cold ${mode} recovers`);
    }
  } finally { await browser.close(); }
}

try {
  const url = await task.serve();
  for (const name of browsers) await checkBrowser(name, url);
} finally { clearTimeout(timer); await task.cleanup(); }
