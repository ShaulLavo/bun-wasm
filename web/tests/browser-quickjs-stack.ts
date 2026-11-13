import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { playwright, run, session, writeFile } from "./playground.mjs";
import { openQuickjsStackPage } from "./quickjs-stack-navigation";

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
  const desktopPolicy = browser.browserType().name() === "webkit";
  const context = await browser.newContext(desktopPolicy ? {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15",
  } : {});
  try {
    // Linux WebKit exercises the policy transport with explicit desktop observations, not Safari qualification.
    if (desktopPolicy) await context.addInitScript(() => {
      Object.defineProperties(navigator, {
        platform: { value: "MacIntel" }, vendor: { value: "Apple Computer, Inc." }, maxTouchPoints: { value: 0 },
      });
    });
    const page = await context.newPage();
    await openQuickjsStackPage(page, url);
    await writeFile(page, "/home/user/depth.js", probe);
    if (desktopPolicy) {
      const selected = await run(page, 'bun -e "console.log(process.env.BUN_WASM_STACK_KIB)"', 90_000);
      assert.equal(selected.code, 0);
      assert.equal(selected.output.trim(), "36", "the page-to-worker route must select desktop Safari policy");
    }
    await check(page);
  } finally { await context.close(); }
}

async function capacity(browser: Browser, url: string): Promise<void> {
  await opened(browser, url, async page => {
    assert.match(await execute(page, "plain", 200), /^completed plain 200$/m);
  });
}

async function nativeCapacity(browser: Browser, url: string, calibration = false): Promise<void> {
  await opened(browser, url, async page => {
    const fixture = new URL("../../tests/fixtures/stack-native-call/", import.meta.url);
    for (const name of ["control.ts", "semantics.ts"]) {
      await writeFile(page, `/home/user/${name}`, readFileSync(new URL(name, fixture), "utf8"));
    }
    const selected = calibration ? "32" : budget ?? (browser.browserType().name() === "webkit" ? undefined : "32");
    const env = selected ? `BUN_WASM_STACK_KIB=${selected} ` : "";
    const result = await run(page, `${env}bun run control.ts`, 90_000);
    assert.equal(result.code, 0, `native call capacity: ${JSON.stringify(result)}`);
    assert.equal(result.output.trim(), readFileSync(new URL("expected.txt", fixture), "utf8").trim());
  });
}

async function fixture(browser: Browser, url: string, name: string): Promise<void> {
  await opened(browser, url, async page => {
    const directory = new URL(`../../tests/fixtures/${name}/`, import.meta.url);
    const entry = name === "parser-error-preservation" || name === "stack-statement-nesting" ? "index.ts" : "index.js";
    await writeFile(page, `/home/user/${entry}`, readFileSync(new URL(entry, directory), "utf8"));
    const env = budget ? `BUN_WASM_STACK_KIB=${budget} ` : "";
    const result = await run(page, `${env}bun run ${entry}`, 90_000);
    assert.equal(result.code, 0, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.output.trim(), readFileSync(new URL("expected.txt", directory), "utf8").trim());
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
    if (name === "webkit" && !budget) await nativeCapacity(browser, url, true);
    await nativeCapacity(browser, url);
    console.log(`PASS ${name}/quickjs budget=${budget ?? "default"} native calls and recovery`);
    const fixtures = name === "webkit" ? ["stack-overflow", "stack-overflow-console", "parser-error-preservation", "stack-statement-nesting"] : [];
    for (const fixtureName of fixtures) await fixture(browser, url, fixtureName);
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
