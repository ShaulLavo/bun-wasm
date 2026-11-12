import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { BrowserContextOptions, BrowserType } from "playwright";
import { checkPageReady } from "./async-context-runtime-page.ts";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";

const { chromium, webkit, devices } = playwright;
const root = new URL("../../tests/async-context-runtime/", import.meta.url);
const source = {
  index: await readFile(new URL("index.ts", root), "utf8"),
  loaded: await readFile(new URL("loaded.ts", root), "utf8"),
  report: await readFile(new URL("report.ts", root), "utf8"),
};
const browsers: Record<string, [BrowserType, BrowserContextOptions | undefined]> = {
  chromium: [chromium, { viewport: { width: 1200, height: 900 } }],
  webkit: [webkit, devices["iPhone 15"]],
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(browsers);
const s = session("bun-wasm-ctx01-");
const failures: string[] = [];

async function exercise(name: string, type: BrowserType, options: BrowserContextOptions | undefined, appUrl: string) {
  const browser = await s.launch(type);
  const context = await browser.newContext(options);
  const page = await context.newPage();
  try {
    await page.goto(`${appUrl}?engine=browser&prompt=off`);
    const status = await ready(page);
    assert.match(status, /ready · Browser \(native\)/);
    await writeFile(page, "/home/user/ctx01/index.ts", source.index);
    await writeFile(page, "/home/user/ctx01/loaded.ts", source.loaded);
    await writeFile(page, "/home/user/ctx01/report.ts", source.report);
    const result = await run(page, "bun run ctx01/index.ts");
    const line = result.output.split("\n").find(value => value.startsWith("CTX01_RESULT "));
    assert.ok(line, result.output);
    const report: unknown = JSON.parse(line.slice("CTX01_RESULT ".length));
    console.log(JSON.stringify({ browser: name, code: result.code, report }));
    checkPageReady(report, name);
    assert.equal(result.code, 0, "passing fixture exits successfully");
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    console.error(failures.at(-1));
  } finally {
    await context.close();
  }
}

try {
  const appUrl = await s.serve();
  for (const name of wanted) {
    const entry = browsers[name];
    assert.ok(entry, `unknown browser ${name}`);
    await exercise(name, entry[0], entry[1], appUrl);
  }
} finally {
  await s.cleanup();
}

if (failures.length > 0) process.exitCode = 1;
