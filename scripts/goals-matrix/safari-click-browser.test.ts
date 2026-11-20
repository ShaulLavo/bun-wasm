import { expect, setDefaultTimeout, test } from "bun:test";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { armNativeClick, observeNativeClick } from "./native-click";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const counter = '<button onclick="document.querySelector(\'output\').textContent=\'1\'">Increment</button><output>0</output>';

async function acceptChangingClock(page: Page, arm: string, observe: string): Promise<void> {
  await page.setContent(counter);
  await page.evaluate("Object.defineProperty(performance, 'timeOrigin', { configurable: true, get: (() => { let value = 123; return () => ++value; })() })");
  try {
    expect(await page.evaluate(arm)).toEqual({ ready: true, before: "0" });
    const first = await page.evaluate("performance.timeOrigin");
    await page.getByRole("button", { name: "Increment" }).click();
    expect(await page.evaluate("performance.timeOrigin")).not.toBe(first);
    expect(await page.evaluate(observe)).toEqual({ trusted: true, after: "1" });
  } finally { await page.evaluate("delete performance.timeOrigin"); }
}

async function rejectDocumentChanges(page: Page, arm: string, observe: string): Promise<void> {
  const cases = [
    { change: "delete globalThis.__goalsNativeClick", detail: "state-missing; statePresent=false" },
    { change: "globalThis.__goalsNativeClick.token = 'different-private-token'", detail: "token-mismatch; statePresent=true; tokenEqual=false" },
    { change: "location.hash = 'private-document-control'", detail: "url-mismatch; statePresent=true; tokenEqual=true; urlEqual=false" },
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

async function rejectChangedDocument(page: Page, arm: string, observe: string): Promise<void> {
  await page.setContent(counter);
  await page.evaluate(arm);
  await page.getByRole("button", { name: "Increment" }).click();
  const evidence = await page.evaluate<{ guards: Record<string, boolean | string>; message: string }>(`(() => {
    const state = globalThis.__goalsNativeClick;
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const other = frame.contentWindow;
    Object.defineProperty(other.performance, 'timeOrigin', { value: performance.timeOrigin });
    other.document.body.append(other.document.adoptNode(state.target));
    other.document.body.append(other.document.adoptNode(document.querySelector('output')));
    other.__goalsNativeClick = state;
    const guards = { tokenEqual: other.__goalsNativeClick.token === ${JSON.stringify("trusted-control")},
      urlEqual: state.url === other.location.href, targetEqual: other.document.querySelector('button') === state.target,
      connected: state.target.isConnected, trusted: state.event.trusted, after: other.document.querySelector('output').textContent,
      timeOriginEqual: other.performance.timeOrigin === performance.timeOrigin };
    return { guards, message: other.eval(${JSON.stringify(`try { ${observe} } catch (error) { error.message }`)}) };
  })()`);
  expect(evidence.guards).toEqual({ tokenEqual: true, urlEqual: true, targetEqual: true, connected: true, trusted: true, after: "1", timeOriginEqual: true });
  expect(evidence.message).toBe("Native click document changed: document-identity-mismatch; statePresent=true; tokenEqual=true; urlEqual=true; documentEqual=false");
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
    await acceptChangingClock(page, arm, observe);
    await rejectChangedDocument(page, arm, observe);
    await rejectDocumentChanges(page, arm, observe);
    await rejectTargetChanges(page, arm, observe);
  } finally { await browser.close(); }
}

for (const engine of [chromium, webkit]) {
  test(`native click document, target and trusted-event guards in actual ${engine.name()} DOM`, () => control(engine), 15_000);
}
