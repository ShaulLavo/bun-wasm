import { withScoped } from "./scope-fixture";
import { expect, test } from "bun:test";
import { campaignDeadlines, cellDeadlines } from "./deadlines";
import { createPlaywrightTransport } from "./transport";

test("the real Firefox transport navigates and renders with the default hang cap", async () => {
  const limits = cellDeadlines(campaignDeadlines(), { framework: "next", browser: "firefox", engine: "browser" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<h1>Hang cap navigation</h1>", { headers: { "Content-Type": "text/html" } }) });
  let transport: Awaited<ReturnType<typeof createPlaywrightTransport>> | undefined;
  try {
    transport = await createPlaywrightTransport("firefox", limits.timeoutMs);
    await withScoped(transport, async page => {
      await page.navigate(server.url.href);
      expect(await page.evaluate("document.querySelector('h1').textContent")).toBe("Hang cap navigation");
    }, limits.timeoutMs);
  } finally {
    await transport?.close();
    await server.stop(true);
  }
}, 300_000);
