import { expect, test } from "bun:test";
import { chromium, webkit, type Browser, type BrowserType } from "playwright";
import { runFixturePhases } from "./fixture-phases";
import { armIphoneClick } from "./iphone-browser";
import { iphoneClickExpression, iphoneClickPredicates, recordIphoneClickTrace } from "./iphone-click";

async function clickControl(engine: BrowserType): Promise<void> {
  const lifetime = new AbortController();
  let browser: Browser | undefined;
  let recorded: ReturnType<typeof recordIphoneClickTrace> | undefined;
  await runFixturePhases(`click ${engine.name()}`, async enter => {
    enter("launch");
    browser = await engine.launch({ headless: true });
    // The trace's 5 s click deadline covers the page work, not browser launch.
    recorded = recordIphoneClickTrace(5000, lifetime.signal);
    const { trace, rows, final } = recorded;
    enter("new-page");
    const page = await browser.newPage();
    enter("set-content");
    await page.setContent('<button onclick="document.querySelector(\'output\').textContent=\'1\'">Increment</button><output>0</output>');
    enter("arm");
    await page.evaluate(() => { globalThis.__goalsIphoneDocument = { nonce: "task", timeOrigin: performance.timeOrigin, url: location.href }; });
    const before = await page.evaluate<ReturnType<typeof armIphoneClick>>(`(${armIphoneClick.toString()})("button","output")`);
    if (!before.ready) throw new Error("Fixture counter did not hydrate");
    trace.armed(before, "1");
    enter("trusted-click");
    await page.getByRole("button", { name: "Increment" }).click();
    trace.observing();
    enter("observe-click");
    const after = await page.evaluate<Record<string, unknown>>(iphoneClickExpression("button", "output"));
    const predicates = iphoneClickPredicates(before, after, "1");
    trace.observed(predicates);
    expect(Object.values(predicates).every(Boolean)).toBe(true);
    expect(after.trusted).toBe(true);
    // A same-document target replacement must still reject the old armed action.
    enter("replace-target");
    await page.evaluate(() => { const button = document.querySelector("button")!; button.replaceWith(button.cloneNode(true)); });
    const replaced = await page.evaluate<Record<string, unknown>>(iphoneClickExpression("button", "output"));
    expect(iphoneClickPredicates(before, replaced, "1")).toEqual({ ...predicates, sameTarget: false });
    enter("trace-delivery");
    trace.finish("passed");
    // Evidence rows are saved asynchronously; wait for the final row, whatever stage the trace ended in.
    expect(await final).toMatchObject({ stage: "passed" });
    expect(rows).toContainEqual(expect.objectContaining({ stage: "observed", predicates }));
    expect(rows.at(-1)?.stage).toBe("passed");
  }, async enter => {
    recorded?.trace.finish("failed");
    lifetime.abort();
    enter("browser-close");
    await browser?.close();
  });
}

for (const engine of [chromium, webkit]) {
  // Generous hang cap only; the phase log names the native step that was still pending.
  test(`real trusted input and same-document target rejection retain click evidence in ${engine.name()}`, () => clickControl(engine), 120_000);
}
