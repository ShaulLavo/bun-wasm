import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType } from "playwright";
import { armNativeClick, observeNativeClick } from "./native-click";

async function control(engine: BrowserType): Promise<void> {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button onclick="document.querySelector(\'output\').textContent=\'1\'">Increment</button><output>0</output>');
    const input = { button: "button", clicked: "output", token: "trusted-control" };
    const arm = `(${armNativeClick.toString()})(${JSON.stringify(input)})`;
    const observe = `(${observeNativeClick.toString()})(${JSON.stringify(input)})`;
    expect(await page.evaluate(arm)).toEqual({ ready: true, before: "0" });
    await page.getByRole("button", { name: "Increment" }).click();
    expect(await page.evaluate(observe)).toEqual({ trusted: true, after: "1" });
    await page.evaluate(() => { document.querySelector("output")!.textContent = "0"; });
    await page.evaluate(arm);
    await page.evaluate(() => { document.querySelector("button")!.click(); });
    await expect(page.evaluate(observe)).rejects.toThrow("trusted event");
  } finally { await browser.close(); }
}

for (const engine of [chromium, webkit]) {
  test(`actual event.isTrusted accepts browser input and rejects DOM click in ${engine.name()}`, () => control(engine), 15_000);
}
