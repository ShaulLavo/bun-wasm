import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType } from "playwright";
import { armIphoneClick } from "./iphone-browser";
import { IphoneClickTrace, iphoneClickExpression, iphoneClickPredicates } from "./iphone-click";

async function clickControl(engine: BrowserType): Promise<void> {
  const browser = await engine.launch({ headless: true });
  const rows: Record<string, unknown>[] = [];
  const lifetime = new AbortController();
  const trace = new IphoneClickTrace(async text => { rows.push(JSON.parse(text)); }, 5000, lifetime.signal);
  try {
    const page = await browser.newPage();
    await page.setContent('<button onclick="document.querySelector(\'output\').textContent=\'1\'">Increment</button><output>0</output>');
    await page.evaluate(() => { globalThis.__goalsIphoneDocument = { nonce: "task", timeOrigin: performance.timeOrigin, url: location.href }; });
    const before = await page.evaluate<ReturnType<typeof armIphoneClick>>(`(${armIphoneClick.toString()})("button","output")`);
    trace.armed(before, "1");
    await page.getByRole("button", { name: "Increment" }).click();
    trace.observing();
    const after = await page.evaluate<Record<string, unknown>>(iphoneClickExpression("button", "output"));
    const predicates = iphoneClickPredicates(before, after, "1");
    trace.observed(predicates);
    expect(Object.values(predicates).every(Boolean)).toBe(true);
    expect(after.trusted).toBe(true);
    // A same-document target replacement must still reject the old armed action.
    await page.evaluate(() => { const button = document.querySelector("button")!; button.replaceWith(button.cloneNode(true)); });
    const replaced = await page.evaluate<Record<string, unknown>>(iphoneClickExpression("button", "output"));
    expect(iphoneClickPredicates(before, replaced, "1")).toEqual({ ...predicates, sameTarget: false });
    trace.finish("passed");
    await Bun.sleep(5);
    expect(rows).toContainEqual(expect.objectContaining({ stage: "observed", predicates }));
    expect(rows.at(-1)?.stage).toBe("passed");
  } finally { trace.finish("failed"); lifetime.abort(); await browser.close(); }
}

for (const engine of [chromium, webkit]) {
  test(`real trusted input and same-document target rejection retain click evidence in ${engine.name()}`, () => clickControl(engine), 15000);
}
