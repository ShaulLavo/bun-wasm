import { expect, test } from "bun:test";
import { frameworks } from "./catalog";
import { checkClick } from "./playground";
import { withScoped } from "./scope-fixture";
import { createPlaywrightTransport } from "./transport";

const framework = frameworks.find(row => row.id === "vite-react");
if (!framework) throw new Error("Missing Vite React fixture");
const counter = `data:text/html,${encodeURIComponent(`<button class="counter"><span>count is 0</span></button>
<script>document.querySelector('button').addEventListener('click', event => {
  document.body.dataset.trusted = String(event.isTrusted);
  setTimeout(() => { document.querySelector('span').textContent = 'count is 1'; }, 20);
});</script>`)}`;

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
