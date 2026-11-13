import type { BrowserContext, Page } from "playwright";
import type { QuotaControl } from "./persistence-quota";

export async function installQuotaControl(context: BrowserContext, page: Page, initialGrant = false) {
  const cdp = context.browser()?.browserType().name() === "chromium"
    ? await context.newCDPSession(page) : undefined;
  const origin = new URL(page.url()).origin;
  const control: QuotaControl = async action => {
    if (!cdp) return false;
    const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
    await cdp.send("Storage.overrideQuotaForOrigin", {
      origin,
      ...(action === "cap" ? { quotaSize: Math.max(1, usage - 1) } : {}),
    });
    return true;
  };
  await page.exposeFunction("storageQuota", control);
  // Set this before the worker opens IndexedDB, which caches its allocation grant.
  if (cdp && initialGrant)
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 8 * 1024 * 1024 });
  return { control, cdp };
}
