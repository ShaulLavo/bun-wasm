// Exercises output produced by bun.wasm, persisted across worker restarts and page visits.
// node sandbox/tests/startup-cache.mjs <url> [--engines browser,quickjs,jsc] [--browsers chromium,webkit]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { firstVisit } from "../../web/tests/first-visit.mjs";
import { playwright } from "../../web/tests/playground.mjs";

const args = process.argv.slice(2);
const base = args.find((arg) => !arg.startsWith("--")) ?? "http://127.0.0.1:4173/";
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const engines = option("engines", "browser,quickjs,jsc").split(",");
const browsers = option("browsers", "chromium,webkit").split(",");
const TIMEOUT = 90_000;
const CACHE = "bunwasm-sandbox-deps";
const cleanups = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void Promise.all(Array.from(cleanups, (cleanup) => cleanup())).then(() => process.exit(130)));

async function rendered(page, heading = "Hello from bun.wasm") {
  const app = page.frameLocator("#preview");
  await app.locator("h1", { hasText: heading }).waitFor({ timeout: TIMEOUT });
  await app.locator("button.counter", { hasText: "count is 0" }).waitFor({ timeout: TIMEOUT });
}

async function phases(page) {
  return page.evaluate(() => performance.getEntries().map((entry) => entry.name));
}

async function clearPhases(page) {
  await page.evaluate(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });
}

async function waitForCache(page) {
  await page.waitForFunction(async (name) => (await (await caches.open(name)).keys()).length > 0, CACHE, { timeout: TIMEOUT });
}

async function checkRestart(page) {
  const app = page.frameLocator("#preview");
  await app.locator("button.counter").click();
  await app.locator("button.counter", { hasText: "count is 1" }).waitFor();
  await clearPhases(page);
  await page.click("#restart");
  await rendered(page);
  const entries = await phases(page);
  assert.ok(entries.includes("bunwasm:deps-cached"), `Restart must restore the dependency bundle: ${JSON.stringify(entries)}`);
  assert.ok(!entries.includes("bunwasm:bundling-react"), "Restart must skip dependency bundling");
  await app.locator("button.counter").click();
  await page.evaluate(() => {
    const { editor, fs } = globalThis.sandbox;
    editor.open("src/App.tsx");
    const source = new TextDecoder().decode(fs.readFile("/home/user/app/src/App.tsx"));
    editor.setText(source.replace("Hello from bun.wasm", "Cached dependencies with hot reload"));
  });
  await app.locator("h1", { hasText: "Cached dependencies with hot reload" }).waitFor({ timeout: TIMEOUT });
  assert.equal(await app.locator("button.counter").textContent(), "count is 1", "Fast Refresh must preserve state after a cached restart");
}

async function checkReload(page) {
  await page.reload();
  await rendered(page, "Cached dependencies with hot reload");
  const entries = await phases(page);
  assert.ok(entries.includes("bunwasm:deps-cached"), `Reload must restore the persistent dependency bundle: ${JSON.stringify(entries)}`);
  assert.ok(!entries.includes("bunwasm:bundling-react"), "Reload must skip dependency bundling");
  assert.ok(entries.includes("bunwasm:engine-cache-hit"), "Reload must restore cached engine bytes");
  assert.ok(!entries.includes("bunwasm:download"), "Cached engine startup must skip the wasm download");
  assert.ok(!entries.includes("bunwasm:decompress"), "Cached engine startup must skip gzip decompression");
}

async function checkCorruption(page) {
  await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.length !== 1) throw new Error(`expected one dependency cache entry, got ${keys.length}`);
    await cache.put(keys[0], new Response(JSON.stringify({ deps: {}, importMap: {} }), { headers: { "content-type": "application/json" } }));
  }, CACHE);
  await page.reload();
  await rendered(page, "Cached dependencies with hot reload");
  const entries = await phases(page);
  assert.ok(entries.includes("bunwasm:bundling-react"), "Invalid persisted output must trigger a real Bun.build");
  assert.ok(entries.includes("bunwasm:bundled-react"), "Invalid persisted output must recover by finishing Bun.build");
  assert.ok(!entries.includes("bunwasm:deps-cached"), "Invalid persisted output must never report a cache hit");
  await page.waitForFunction(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const text = await (await cache.match(keys[0])).text();
    try {
      return Object.keys(JSON.parse(text).deps).length > 0;
    } catch {
      return false;
    }
  }, CACHE, { timeout: TIMEOUT });
  await checkReload(page);
}

async function checkEditedDependencies(page) {
  await page.evaluate(() => {
    const { editor, fs } = globalThis.sandbox;
    editor.open("package.json");
    editor.setText(new TextDecoder().decode(fs.readFile("/home/user/app/package.json")) + "\n");
  });
  await page.waitForFunction(() => Object.hasOwn(JSON.parse(sessionStorage.getItem("bun-wasm-sandbox:edits") ?? "{}"), "package.json"));
  await clearPhases(page);
  await page.click("#restart");
  await page.waitForFunction(() => performance.getEntriesByName("bunwasm:bundled-react").length > 0, null, { timeout: TIMEOUT });
  await rendered(page, "Cached dependencies with hot reload");
  assert.ok(!(await phases(page)).includes("bunwasm:deps-cached"), "Editing package.json must invalidate the bundle on Restart");
  await page.reload();
  await rendered(page, "Cached dependencies with hot reload");
  const entries = await phases(page);
  assert.ok(entries.includes("bunwasm:bundled-react"), "Editing package.json must invalidate the persistent bundle on reload");
  assert.ok(!entries.includes("bunwasm:deps-cached"), "Edited dependency manifests must never restore the template bundle");
}

async function check(browserName, engine) {
  const profile = mkdtempSync("/work/tmp/bun-wasm-startup-cache-");
  let context;
  let visit;
  let closing;
  const cleanup = () => closing ??= (async () => {
    await context?.close();
    await visit?.close();
    rmSync(profile, { recursive: true, force: true });
  })();
  cleanups.add(cleanup);
  try {
    // WebKit's ephemeral contexts can discard CacheStorage on reload. A fresh disk profile
    // exercises the same persistence as ordinary Safari without reusing another test's data.
    context = await playwright[browserName].launchPersistentContext(profile, browserName === "webkit" ? { ...playwright.devices["iPhone 15"] } : {});
    const url = new URL(base);
    url.searchParams.set("engine", engine);
    visit = await firstVisit(context, url.href);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(visit.url);
    await rendered(page);
    await visit.check(page, engine === "browser");
    assert.ok((await phases(page)).includes("bunwasm:bundled-react"), "Cold visit must bundle React in bun.wasm");
    await waitForCache(page);
    await checkRestart(page);
    await checkReload(page);
    await checkCorruption(page);
    await checkEditedDependencies(page);
    assert.deepEqual(errors, [], "Cached startup must not report page errors");
    console.log(`ok   ${browserName}/${engine}: cold bundle, cached Restart, HMR, cached reload, corrupt-cache recovery, manifest invalidation`);
  } finally {
    await cleanup();
    cleanups.delete(cleanup);
  }
}

let failed = 0;
for (const browser of browsers) {
  for (const engine of engines) {
    try {
      await check(browser, engine);
    } catch (error) {
      failed++;
      console.error(`FAIL ${browser}/${engine}: ${error.stack}`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
