import { expect, test } from "bun:test";
import { chromium, firefox, webkit, type Browser } from "playwright";
import { resolve, join } from "node:path";
import { preservationScenario, accumulation } from "../sandbox/tests/storage-browser";
import { verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";

const requested = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
const browsers = Array.from(new Set(requested.flatMap(name => name === "chromium" ? ["chromium", "firefox"] : [name])));

async function siteCheck(name: string, run: (browser: Browser, url: string) => Promise<void>): Promise<void> {
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (!provided) throw new Error("Provide the existing browser-guest site. This consumer never builds a guest or site.");
  const directory = resolve(provided);
  const before = verifySite(directory);
  const task = session("bun-wasm-storage-");
  const previousRoot = process.env.ROOT;
  try {
    process.env.ROOT = join(directory, "site");
    const url = new URL("sandbox/", await task.serve()).href;
    const engine = { chromium, firefox, webkit }[name];
    if (!engine) throw new Error(`Unsupported browser ${name}`);
    const browser = await task.launch(engine);
    await run(browser, url);
    expect(verifySite(directory)).toEqual(before);
  } finally {
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
    await task.cleanup();
  }
}

for (const name of browsers) test(`${name}: sandbox keeps active tabs and restores guest-created source after LRU eviction`, () => siteCheck(name, preservationScenario), 420_000);

test("chromium: a recorded single-install quota admits repeated framework switching", async () => {
  if (!requested.includes("chromium")) return;
  const quotaSize = Number(process.env.BUN_WASM_STORAGE_QUOTA ?? 240 * 1024 * 1024);
  if (!Number.isSafeInteger(quotaSize) || quotaSize <= 0) throw new Error("Invalid storage quota cap");
  await siteCheck("chromium", async (browser, base) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(new URL("engine-builds.json", base).href);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Storage.overrideQuotaForOrigin", { origin: new URL(base).origin, quotaSize });
      const rows = await accumulation(context, base, ["vanilla", "vite-react", "vite-vue", "vite-svelte"]);
      expect(rows).toHaveLength(4);
      expect(rows.filter(row => row.error)).toEqual([]);
      if (process.env.BUN_WASM_STORAGE_REPORT) await Bun.write(process.env.BUN_WASM_STORAGE_REPORT, JSON.stringify({ quotaSize, browser: browser.version(), rows }, null, 2));
    } finally { await context.close(); }
  });
}, 420_000);
