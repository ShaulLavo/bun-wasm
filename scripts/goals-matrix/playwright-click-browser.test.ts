import { expect, test } from "bun:test";
import { frameworks, type Framework } from "./catalog";
import { checkClick, until } from "./playground";
import { withScoped } from "./scope-fixture";
import { createPlaywrightTransport, scoped, type ScopedTransport, type Transport } from "./transport";
import { Scope } from "./scope";
import { armNativeClick, observeNativeClick } from "./native-click";

const framework = frameworks.find(row => row.id === "vite-react");
if (!framework) throw new Error("Missing Vite React fixture");
const counter = `data:text/html,${encodeURIComponent(`<button class="counter"><span>count is 0</span></button>
<script>document.querySelector('button').addEventListener('click', event => {
  document.body.dataset.trusted = String(event.isTrusted);
  setTimeout(() => { document.querySelector('span').textContent = 'count is 1'; }, 20);
});</script>`)}`;

async function rejectInvalidClicks(page: ScopedTransport, framework: Framework): Promise<void> {
  await page.navigate(counter);
  await page.evaluate("document.querySelector('span').textContent = 'count is 2'");
  await expect(checkClick(page, framework, 3000)).rejects.toThrow("Counter must start at zero");
  expect(await page.evaluate("document.body.dataset.trusted")).toBeUndefined();

  await page.navigate(counter);
  await page.evaluate("document.querySelector('button').disabled = true");
  await expect(checkClick(page, framework, 80)).rejects.toThrow("80 ms");
  await page.evaluate("document.querySelector('button').disabled = false");
  expect(await page.evaluate("new Promise(resolve => setTimeout(() => resolve(document.body.dataset.trusted), 150))")).toBeUndefined();
  expect(await page.evaluate("document.querySelector('button').textContent")).toBe("count is 0");
  expect(await checkClick(page, framework, 3000)).toMatchObject({ trusted: true, after: "count is 1" });

  await page.navigate(counter);
  const input = { button: framework.button, clicked: framework.clicked, token: "synthetic-control" };
  await page.evaluate(`(${armNativeClick.toString()})(${JSON.stringify(input)})`);
  await page.evaluate("document.querySelector('button').click()");
  await expect(page.evaluate(`(${observeNativeClick.toString()})(${JSON.stringify(input)})`)).rejects.toThrow("trusted event");
}

async function rejectBlockedClick(transport: Transport, framework: Framework, mode: "abort" | "deadline"): Promise<void> {
  const scope = Scope.open(5000);
  const page = scoped(transport, scope);
  try {
    await page.navigate(counter);
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="cover" style="position:fixed;inset:0;z-index:100;background:white"></div>')`);
    const clicking = checkClick(page, framework, mode === "abort" ? 3000 : 400).then(() => "clicked", error => String(error));
    await until(() => page.evaluate<boolean>("globalThis.__goalsNativeClick !== undefined"), Boolean, 2000);
    if (mode === "abort") scope.close(new Error("Click cancelled during actionability"));
    expect(await clicking).toMatch(mode === "abort" ? /Click cancelled during actionability/ : /timed out|Timeout \d+ms exceeded/i);
    await withScoped(transport, async observer => {
      await observer.evaluate("document.querySelector('#cover').remove()");
      const trusted = await observer.evaluate("new Promise(resolve => setTimeout(() => resolve(document.body.dataset.trusted), 1000))");
      expect(trusted).toBeUndefined();
      expect(await observer.evaluate("document.querySelector('button').textContent")).toBe("count is 0");
      expect(await checkClick(observer, framework, 3000)).toMatchObject({ trusted: true, after: "count is 1" });
    });
  } finally { scope.close(); }
}

async function clickFirstCounter(page: ScopedTransport, framework: Framework): Promise<void> {
  await page.navigate(counter);
  await page.evaluate(`document.body.insertAdjacentHTML('beforeend', '<button id="devtools">Dev tools</button>'); document.querySelector('#devtools').onclick = () => { document.body.dataset.wrongTarget = 'true'; }`);
  const genericCounter = { ...framework, button: "button", clicked: "button" };
  expect(await checkClick(page, genericCounter, 3000)).toMatchObject({ trusted: true, after: "count is 1" });
  expect(await page.evaluate("document.body.dataset.wrongTarget")).toBeUndefined();
}

async function clickPartiallyVisibleCounter(page: ScopedTransport, framework: Framework): Promise<void> {
  for (const position of ["right:-90px;top:40px", "left:-90px;top:40px", "left:40px;top:-30px"]) {
    await page.navigate(counter);
    await page.evaluate(`document.querySelector('button').style.cssText = ${JSON.stringify(`position:fixed;width:100px;height:40px;${position}`)}`);
    expect(await checkClick(page, framework, 3000)).toMatchObject({ trusted: true, after: "count is 1" });
  }
}

for (const kind of ["chrome", "firefox"] as const) {
  test(`checkClick delivers trusted input to the selected ${kind} page`, async () => {
    const transport = await createPlaywrightTransport(kind, 5000, 5000, true);
    try {
      await withScoped(transport, async page => {
        await page.navigate(counter);
        await page.openPreview(counter);
        const result = await checkClick(page, framework, 3000);
        const trusted = await page.evaluate("document.body.dataset.trusted");
        console.info(JSON.stringify({ browser: transport.capabilities, trusted, result }));
        expect(trusted).toBe("true");
        expect(result).toMatchObject({ before: "count is 0", after: "count is 1", trusted: true });
        await page.useHost();
        expect(await page.evaluate("document.querySelector('button').textContent")).toBe("count is 0");
        expect(await checkClick(page, framework, 3000)).toMatchObject({ before: "count is 0", after: "count is 1", trusted: true });
        await page.usePreview();
        expect(await page.evaluate("document.body.dataset.trusted")).toBe("true");
        await page.closePreview();
        expect(await page.evaluate("document.body.dataset.trusted")).toBe("true");
        await rejectInvalidClicks(page, framework);
        await clickFirstCounter(page, framework);
        await clickPartiallyVisibleCounter(page, framework);
      });
      await rejectBlockedClick(transport, framework, "abort");
      await rejectBlockedClick(transport, framework, "deadline");
      console.info(JSON.stringify({ browser: transport.capabilities, trusted: true, pages: ["preview", "host"] }));
    } finally {
      await transport.close();
      const root = transport.processRoot;
      expect(root).toBeNumber();
      if (root !== undefined) expect(() => process.kill(root, 0)).toThrow();
    }
  }, 30_000);
}
