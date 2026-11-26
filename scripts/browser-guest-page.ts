import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";

/** Serves the browser-guest site (CI's BUN_WASM_BROWSER_SITE, or one built in scratch from
 * dist/bun-browser.wasm), launches `browserName` and runs `scenario` against the page URL.
 * The site's inventory must be unchanged afterwards. `prefix` names the scratch directories. */
export async function withGuestSite(browserName: string, prefix: string,
  scenario: (browser: Browser, url: string) => Promise<void>): Promise<void> {
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (process.env.CI && !provided) throw new Error("CI must provide the existing browser-guest site");
  const scratch = provided ? undefined : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `${prefix}-site-`));
  const directory = provided ? resolve(provided) : scratch!;
  const previousRoot = process.env.ROOT;
  const task = session(`${prefix}-browser-`);
  try {
    const before = provided ? verifySite(directory) : buildSite(directory);
    process.env.ROOT = join(directory, "site");
    const url = await task.serve();
    if (browserName !== "chromium" && browserName !== "webkit") throw new Error(`Unsupported browser ${browserName}`);
    const browser = await task.launch(browserName === "chromium" ? chromium : webkit);
    await scenario(browser, url);
    expect(verifySite(directory)).toEqual(before);
  } finally {
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
    await task.cleanup();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
