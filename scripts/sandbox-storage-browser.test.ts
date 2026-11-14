import { afterEach, expect, test } from "bun:test";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { resolve, join } from "node:path";
import { preservationScenario, quotaRefusalScenario, storageReportPath } from "../sandbox/tests/storage-browser";
import { verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";
import { handleStorageFailure } from "./storage-ci-quarantine";
import { storageEvidence, type StorageLifetime, type StorageObservation } from "./storage-browser-evidence";

const requested = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
const browsers = Array.from(new Set(requested.flatMap(name => name === "chromium" ? ["chromium", "firefox"] : [name])));
const lifetimes: StorageLifetime[] = [];

afterEach(async () => {
  const owned = lifetimes.splice(0);
  await Promise.all(owned.map(lifetime => lifetime.cleanup()));
  const failures = owned.flatMap(lifetime => lifetime.failures);
  if (failures.length) throw new AggregateError(failures, "Storage evidence or cleanup failed");
});

async function siteCheck(name: string, run: (browser: Browser, url: string, observer?: StorageObservation) => Promise<void>, scenario = "preservation"): Promise<void> {
  const report = process.env.CI === "true" ? storageReportPath() : undefined;
  const lifetime = storageEvidence(report ? `${report.replace(/\.json$/, "")}-${name}-${scenario}-progress.jsonl` : undefined);
  lifetimes.push(lifetime);
  await lifetime.run(() => checkedSite(name, run, lifetime));
}

async function checkedSite(name: string, run: (browser: Browser, url: string, observer?: StorageObservation) => Promise<void>, lifetime: StorageLifetime): Promise<void> {
  const development = process.env.BUN_WASM_STORAGE_DEVELOPMENT_URL;
  if (development) {
    if (process.env.CI) throw new Error("CI must consume the verified browser-guest producer artifact");
    const engine = { chromium, firefox, webkit }[name];
    if (!engine) throw new Error(`Unsupported browser ${name}`);
    const { value: browser } = await lifetime.acquire("browser.launch", () => engine.launch({ headless: true }), browser => browser.close());
    await run(browser, development);
    return;
  }
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (!provided) throw new Error("Provide the existing browser-guest site. This consumer never builds a guest or site.");
  const directory = resolve(provided);
  const before = await lifetime.step("producer.verify.before", () => verifySite(directory));
  const task = session("bun-wasm-storage-");
  const previousRoot = process.env.ROOT;
  lifetime.own("session.cleanup", async () => {
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
    await task.cleanup();
  });
  process.env.ROOT = join(directory, "site");
  const url = new URL("sandbox/", await lifetime.step("site.serve", () => task.serve())).href;
  const engine = { chromium, firefox, webkit }[name];
  if (!engine) throw new Error(`Unsupported browser ${name}`);
  const { value: browser } = await lifetime.acquire("browser.launch", () => engine.launch(), browser => browser.close());
  if (lifetime.observation) lifetime.observeBrowser(browser);
  await lifetime.step("scenario", () => run(browser, url, lifetime.observation));
  const after = await lifetime.step("producer.verify.after", () => verifySite(directory));
  await lifetime.step("producer.assert", () => expect(after).toEqual(before));
}

for (const name of browsers) test(`${name}: sandbox keeps active tabs and restores guest-created source after LRU eviction`, () => siteCheck(name, async (browser, url, observer) => {
  try { await preservationScenario(browser, url, observer); }
  catch (error) { await handleStorageFailure(name, error); }
}), 420_000);

test("chromium: full-origin preservation failure keeps idle source and pending editor text", async () => {
  if (!requested.includes("chromium")) return;
  await siteCheck("chromium", quotaRefusalScenario, "quota");
}, 240_000);
