import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { firstVisit } from "../../web/tests/first-visit.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "../../web/node_modules/playwright/index.mjs");

test("closing the first-visit proxy cancels its pending upstream response", async () => {
  const incoming = Promise.withResolvers<Socket>();
  const upstream = createServer((request, response) => {
    incoming.resolve(request.socket);
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("pending");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  let browser, visit, body;
  try {
    browser = await chromium.launch();
    visit = await firstVisit(await browser.newContext(), `http://127.0.0.1:${address.port}/`);
    body = (await fetch(visit.url, { signal: AbortSignal.timeout(5_000) })).body;
    const socket = await incoming.promise;
    const closing = Promise.withResolvers<void>();
    socket.once("error", () => {});
    socket.once("close", () => closing.resolve());
    const timeout = AbortSignal.timeout(1_000);
    const closed = Promise.race([closing.promise, once(timeout, "abort").then(() => { throw timeout.reason; })]);
    await Promise.all([closed, visit.close()]);
    visit = undefined;
    assert.equal(socket.destroyed, true);
  } finally {
    try { await Promise.all([body?.cancel().catch(() => {}), visit?.close(), browser?.close()]); }
    finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  }
});


test("a live first visit keeps the real HTTPS origin", async () => {
  const browser = await chromium.launch();
  let visit;
  try {
    const context = await browser.newContext();
    visit = await firstVisit(context, "https://bun.sprockt.dev/?engine=browser", { delayActivation: false });
    assert.equal(visit.url, "https://bun.sprockt.dev/?engine=browser");
  } finally {
    try { await browser.close(); }
    finally { await visit?.close(); }
  }
});
