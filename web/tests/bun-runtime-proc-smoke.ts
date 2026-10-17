import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { runForeground } from "./foreground";

/** Optional caller-built production site, not a replacement UI or a test-only startup. */
export async function bunRuntimeProcSmoke(browser: Browser, origin: string) {
  const page: Page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${origin}/site/playground/?engine=browser&wasm=/bun-browser.wasm`);
    await page.waitForFunction(() => Reflect.get(globalThis, "playground") && /ready/.test(document.querySelector("#status")?.textContent ?? ""), undefined, { timeout: 120_000 });
    const result = await runForeground(page, `bun -e "const p=Bun.spawn(['bun','-e','console.log(73)'],{stdout:'inherit',stderr:'inherit'});if(await p.exited!==0)throw Error('site child failed')"`, 60_000);
    assert.equal(result.code, 0, "production playground nested Bun process");
    const terminal: string = await page.evaluate(async () => {
      const { term } = Reflect.get(globalThis, "playground");
      await new Promise(resolve => term.write("", resolve));
      const buffer = term.buffer.active;
      return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n");
    });
    assert.match(terminal, /(?:^|\n)73(?:\r?\n|$)/);
    await page.goto(`${origin}/site/?engine=browser&template=vanilla&wasm=/bun-browser.wasm`);
    const app = page.frameLocator("#preview");
    await app.locator("h1", { hasText: "Hello from vanilla TypeScript" }).waitFor({ timeout: 180_000 });
    const counter = app.locator("button.counter");
    await counter.click();
    await app.locator("button.counter", { hasText: "count is 1" }).waitFor({ timeout: 20_000 });
    assert.deepEqual(errors, []);
    return { playground: "nested Bun.spawn exits 0 and prints 73", sandbox: "vanilla preview renders and counter updates", pageErrors: errors };
  } finally { await page.close(); }
}
