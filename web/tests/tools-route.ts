import type { Page } from "playwright";

/** Install before navigation; changing interception later also awaits live worker sessions. */
export async function installToolsRoute(page: Page, substituted: Buffer): Promise<() => void> {
  let verified = false;
  await page.route("**/bun-tools.wasm.gz*", route => {
    if (verified) return route.continue();
    return route.fulfill({ status: 200, headers: { "content-type": "application/wasm" }, body: substituted });
  });
  return () => { verified = true; };
}
