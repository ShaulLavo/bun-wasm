import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { armNativeClick, observeNativeClick } from "./native-click";

const counter = '<button onclick="document.querySelector(\'output\').textContent=\'1\'">Increment</button><output>0</output>';

async function rejectDocumentChanges(page: Page, arm: string, observe: string): Promise<void> {
  const cases = [
    { change: "delete globalThis.__goalsNativeClick", detail: "state-missing; statePresent=false" },
    { change: "globalThis.__goalsNativeClick.token = 'different-private-token'", detail: "token-mismatch; statePresent=true; tokenEqual=false" },
    { change: "location.hash = 'private-document-control'", detail: "url-mismatch; statePresent=true; tokenEqual=true; urlEqual=false" },
    { change: "globalThis.__goalsNativeClick.timeOrigin += 1", detail: "time-origin-mismatch; statePresent=true; tokenEqual=true; urlEqual=true; timeOriginEqual=false" },
  ];
  for (const row of cases) {
    await page.setContent(counter);
    expect(await page.evaluate(arm)).toEqual({ ready: true, before: "0" });
    await page.getByRole("button", { name: "Increment" }).click();
    await page.evaluate(row.change);
    const message = await page.evaluate(`try { ${observe} } catch (error) { error.message }`);
    expect(message).toBe(`Native click document changed: ${row.detail}`);
  }
}

async function rejectTargetChanges(page: Page, arm: string, observe: string): Promise<void> {
  for (const change of ["document.querySelector('button').remove()", "document.querySelector('button').insertAdjacentHTML('beforebegin', '<button>Replacement</button>')"]) {
    await page.setContent(counter);
    await page.evaluate(arm);
    await page.evaluate(change);
    await expect(page.evaluate(observe)).rejects.toThrow("Native click target changed");
  }
  await page.setContent(counter);
  await page.evaluate(arm);
  await page.getByRole("button", { name: "Increment" }).click();
  await page.evaluate(() => { globalThis.__goalsNativeClick!.event!.target = document.querySelector("output"); });
  await expect(page.evaluate(observe)).rejects.toThrow("trusted event to the armed target");
}

async function control(engine: BrowserType): Promise<void> {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(counter);
    const input = { button: "button", clicked: "output", token: "trusted-control" };
    const arm = `(${armNativeClick.toString()})(${JSON.stringify(input)})`;
    const observe = `(${observeNativeClick.toString()})(${JSON.stringify(input)})`;
    expect(await page.evaluate(arm)).toEqual({ ready: true, before: "0" });
    expect(await page.evaluate(observe)).toEqual({ trusted: false, after: "0" });
    await page.getByRole("button", { name: "Increment" }).click();
    expect(await page.evaluate(observe)).toEqual({ trusted: true, after: "1" });
    await page.evaluate(() => { document.querySelector("output")!.textContent = "0"; });
    await page.evaluate(arm);
    await page.evaluate(() => { document.querySelector("button")!.click(); });
    await expect(page.evaluate(observe)).rejects.toThrow("trusted event");
    await rejectDocumentChanges(page, arm, observe);
    await rejectTargetChanges(page, arm, observe);
  } finally { await browser.close(); }
}

for (const engine of [chromium, webkit]) {
  test(`native click document, target and trusted-event guards in actual ${engine.name()} DOM`, () => control(engine), 15_000);
}
