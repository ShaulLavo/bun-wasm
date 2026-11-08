import assert from "node:assert/strict";
import { test } from "bun:test";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { LoopbackPreviewOrigins } from "../web/preview-origin-host";
import { fixture } from "../web/tests/fixtures/preview-origin-native";

const registry = new LoopbackPreviewOrigins();
let browser: Browser | undefined;
let closing: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return closing ??= Promise.all([browser?.close(), registry.close()]).then(() => {});
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });

const observations: { path: string; cookie: string | null; site: string | null }[] = [];
function endpoint(label: string) {
  const target = fixture(label);
  target.fetch = request => {
    observations.push({ path: new URL(request.url).pathname, cookie: request.headers.get("cookie"), site: request.headers.get("sec-fetch-site") });
    const headers = new Headers({ "content-type": "text/html" });
    if (new URL(request.url).pathname === "/cookies") {
      headers.append("set-cookie", `scoped=${label}; Path=/`);
      headers.append("set-cookie", `parent=${label}; Domain=localhost; Path=/`);
    }
    return new Response("<!doctype html><p>root preview</p>", { headers });
  };
  return target;
}

async function verify(name: keyof typeof engines, first: string, sibling: string, foreign: string): Promise<void> {
  browser = await engines[name].launch({ headless: true });
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    await page.goto(`${first}/cookies`);
    assert.equal(await page.evaluate(() => document.cookie), "scoped=first", `${name}: reject parent localhost cookie`);
    await page.goto(sibling);
    assert.equal(await page.evaluate(() => document.cookie), "", `${name}: sibling virtual port has a separate cookie host`);
    assert.equal(observations.at(-1)?.cookie, null);
    await page.goto(foreign);
    assert.equal(await page.evaluate(() => document.cookie), "", `${name}: foreign owner has a separate cookie host`);
    assert.equal(observations.at(-1)?.cookie, null);
    await page.goto(first);
    assert.equal(observations.at(-1)?.cookie, "scoped=first");
    await page.evaluate(async url => { await fetch(url, { method: "POST", mode: "no-cors", body: "site-check" }); }, `${sibling}/site-check`);
    assert.equal(observations.findLast(row => row.path === "/site-check")?.site, "cross-site", `${name}: distinct roots must remain cross-site`);
    const before = observations.length;
    await page.evaluate(async url => { await fetch(url, { method: "POST", mode: "no-cors", body: "forbidden" }); }, foreign);
    assert.equal(observations.length, before, `${name}: foreign owner request never dispatches`);
    console.log(`${name}: localhost resolution, host cookies, parent-cookie rejection and cross-site metadata passed`);
  } finally {
    await browser.close();
    browser = undefined;
  }
}

const engines = { chromium, firefox, webkit };
test("loopback hostname origins retain browser cookie and site isolation", async () => {
  try {
    const owner = {};
    const first = await registry.bind(owner, 3137, endpoint("first"));
    const sibling = await registry.bind(owner, 3138, endpoint("sibling"));
    const foreign = await registry.bind({}, 3137, endpoint("foreign"));
    const names = (process.env.BUN_WASM_PREVIEW_BROWSERS ?? "chromium,webkit").split(",");
    for (const name of names) {
      if (name !== "chromium" && name !== "firefox" && name !== "webkit") throw new Error("Unknown preview browser");
      await verify(name, first.origin, sibling.origin, foreign.origin);
    }
  } finally { await cleanup(); }
}, 45_000);
