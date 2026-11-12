import { withScoped } from "./scope-fixture";
import { expect, test } from "bun:test";
import { campaignDeadlines, cellDeadlines } from "./deadlines";
import { createPlaywrightTransport } from "./transport";

test("the real Firefox transport enforces the calibrated Browser cell navigation timeout", async () => {
  const limits = cellDeadlines(campaignDeadlines(), { framework: "next", browser: "firefox", engine: "browser" });
  const stalled = Promise.withResolvers<Response>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => stalled.promise });
  let transport: Awaited<ReturnType<typeof createPlaywrightTransport>> | undefined;
  try {
    transport = await createPlaywrightTransport("firefox", limits.timeoutMs);
    await expect(withScoped(transport, page => page.navigate(server.url.href))).rejects.toThrow(`Timeout ${limits.timeoutMs}ms exceeded`);
  } finally {
    stalled.resolve(new Response("owned fixture stopped"));
    await transport?.close();
    await server.stop(true);
  }
}, 15_000);
