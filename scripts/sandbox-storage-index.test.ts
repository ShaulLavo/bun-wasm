import { expect, test } from "bun:test";
import { chromium, firefox, webkit } from "playwright";
import { indexTransactions, quotaTransaction, refusedQuotaTransaction } from "../sandbox/tests/workspace-index";

declare global {
  var sandboxIndexChecks: {
    indexTransactions: typeof indexTransactions;
    quotaTransaction: typeof quotaTransaction;
    refusedQuotaTransaction: typeof refusedQuotaTransaction;
  };
}

test("native browser source index transactions and races", async () => {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../sandbox/tests/workspace-index.ts`], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, "index test bundle failed");
  const bytes = await build.outputs[0]!.text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => new URL(request.url).pathname === "/test.js" ? new Response(bytes, { headers: { "content-type": "text/javascript" } }) : new Response('<script type="module" src="/test.js"></script>', { headers: { "content-type": "text/html" } }) });
  try {
    for (const engine of [chromium, firefox, webkit]) await nativeTransactions(engine, server.url.origin);
  } finally { await server.stop(true); }
}, 120_000);

async function nativeTransactions(engine: typeof chromium, origin: string): Promise<void> {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => !!globalThis.sandboxIndexChecks);
    expect(await page.evaluate(() => sandboxIndexChecks.indexTransactions())).toHaveLength(6);
    if (engine !== chromium) return;
    await quotaControl(browser, origin);
  } finally { await browser.close(); }
}

async function quotaControl(browser: Awaited<ReturnType<typeof chromium.launch>>, origin: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => !!globalThis.sandboxIndexChecks);
    const cdp = await context.newCDPSession(page);
    // Cap before the first IndexedDB write so Chromium never caches a large space grant.
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 4 * 1024 * 1024 });
    await page.evaluate(() => sandboxIndexChecks.quotaTransaction());
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1024 });
    expect(await page.evaluate(() => sandboxIndexChecks.refusedQuotaTransaction())).toEqual(["native-quota-transaction-refused-and-source-retained"]);
  } finally { await context.close(); }
}
