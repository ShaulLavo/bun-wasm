import { expect, test } from "bun:test";
import { frameworks, type Framework } from "./catalog";
import { checkClick } from "./playground";
import { withScoped } from "./scope-fixture";
import { createPlaywrightTransport, type ScopedTransport } from "./transport";
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
      });
      console.info(JSON.stringify({ browser: transport.capabilities, trusted: true, pages: ["preview", "host"] }));
    } finally {
      await transport.close();
      const root = transport.processRoot;
      expect(root).toBeNumber();
      if (root !== undefined) expect(() => process.kill(root, 0)).toThrow();
    }
  }, 30_000);
}
