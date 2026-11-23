import type { Page } from "playwright";
import { gunzipSync } from "node:zlib";

/**
 * Install before navigation; changing interception later also awaits live worker sessions.
 * `substituted` is a gzip stream: the loader's logical `bun-tools.wasm` request gets its decoded
 * bytes, as a negotiating host's native Content-Encoding would deliver them, and a `.gz` request the stream.
 */
export async function installToolsRoute(page: Page, substituted: Buffer): Promise<() => void> {
  let verified = false;
  const decoded = gunzipSync(substituted);
  await page.route(url => /\/bun-tools\.wasm(?:\.gz)?$/.test(url.pathname), route => {
    if (verified) return route.continue();
    const gzip = new URL(route.request().url()).pathname.endsWith(".gz");
    return route.fulfill({ status: 200, headers: { "content-type": "application/wasm" }, body: gzip ? substituted : decoded });
  });
  return () => { verified = true; };
}
