import { expect, test } from "bun:test";
import { installHmrConnection, waitForHmrConnection } from "./hmr-connection.ts";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "../../web/node_modules/playwright/index.mjs");
const connected = "[Bun] Hot-module-reloading socket connected, waiting for changes...";

test("HMR readiness belongs to the target document across tabs and navigation", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const html = new URL(request.url).pathname === '/frame' ? '<!doctype html><p>preview</p>' : '<!doctype html><iframe id="preview" src="/frame"></iframe>';
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    await installHmrConnection(context);
    const owner = await context.newPage();
    const tab = await context.newPage();
    await owner.goto(server.url.href);
    await tab.goto(server.url.href);
    await owner.evaluate(text => console.info(text), connected);
    await expect(waitForHmrConnection(tab, null, 150)).rejects.toThrow();
    await tab.evaluate(text => console.info(text), connected);
    await waitForHmrConnection(tab);
    await tab.evaluate(() => console.warn("[Bun] Hot-module-reloading socket disconnected, reconnecting..."));
    await expect(waitForHmrConnection(tab, null, 150)).rejects.toThrow();
    await tab.evaluate(() => console.info("[Bun] Reconnected"));
    await waitForHmrConnection(tab);
    await tab.reload();
    await expect(waitForHmrConnection(tab, null, 150)).rejects.toThrow();
    await tab.evaluate(text => console.info(text), connected);
    await waitForHmrConnection(tab);
    await expect(waitForHmrConnection(owner, "#preview", 150)).rejects.toThrow();
    const frame = owner.frames().find(frame => frame.parentFrame() !== null);
    if (!frame) throw new Error("Missing preview frame");
    await frame.evaluate(text => console.info(text), connected);
    await waitForHmrConnection(owner, "#preview");
    await frame.goto(new URL("/frame?restarted", server.url).href);
    await expect(waitForHmrConnection(owner, "#preview", 150)).rejects.toThrow();
    await frame.evaluate(text => console.info(text), connected);
    await waitForHmrConnection(owner, "#preview");
  } finally {
    try { await browser?.close(); }
    finally { server.stop(true); }
  }
}, 30_000);
