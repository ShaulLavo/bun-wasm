import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { chromium, firefox, webkit } from "playwright";
import { verifySite } from "./browser-guest-site";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";

async function checkRejections(page: Page, extension: string): Promise<void> {
  await writeFile(page, `/home/user/entry.${extension}`, 'import("./failure.mjs");');
  const ignored = await run(page, `bun run entry.${extension}`, 10000);
  expect(ignored.code, ignored.output).toBe(1);
  expect(ignored.output).toContain("dynamic-import-startup-marker");
  await writeFile(page, `/home/user/entry.${extension}`, 'import("./failure.mjs").catch(error => console.log("caught", error.message));');
  const caught = await run(page, `bun run entry.${extension}`, 10000);
  expect(caught.code, caught.output).toBe(0);
  expect(caught.output).toBe("caught dynamic-import-startup-marker");
}

const browsers = { chromium, firefox, webkit };
const selected = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
for (const name of selected) {
  const type = Object.entries(browsers).find(([key]) => key === name)?.[1];
  if (!type) throw new Error(`Unknown browser: ${name}`);
  test(`${name} dynamic imports preserve unhandled and caught rejections`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    const root = provided ? join(provided, "site") : resolve(import.meta.dir, "../web/dist");
    const before = provided ? verifySite(provided) : undefined;
    const task = session("bun-wasm-import-rejection-");
    try {
      const [, origin] = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: root, PORT: "0" });
      const browser = await task.launch(type);
      const page = await browser.newPage({ serviceWorkers: "block" });
      await page.goto(`${origin}?engine=browser&prompt=off&mode=memory`);
      expect(await ready(page)).toContain("ready · Browser");
      await writeFile(page, "/home/user/failure.mjs", 'throw new Error("dynamic-import-startup-marker");');
      await checkRejections(page, "mjs");
      await checkRejections(page, "cjs");
    } finally { await task.cleanup(); }
    if (provided && before) expect(verifySite(provided)).toEqual(before);
  }, 180000);
}
