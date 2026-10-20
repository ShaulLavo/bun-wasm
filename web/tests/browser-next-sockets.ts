import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Page } from "playwright";
import { playwright, ready, session, writeFile } from "./playground.mjs";
import { stopForeground } from "./foreground";
import { observePreviewSockets, previewSocketEvents } from "./next-framework-sockets";

type Playground = typeof globalThis & {
  playground: {
    shell: { submit(command: string): Promise<void> };
    previews: { serves(port: number): boolean; url(port: number): string };
  };
};
const assets = process.env.NEXT_WEB_ROOT;
const guest = process.env.NEXT_GUEST_WASM;
if (!assets || !guest) throw new Error("Set NEXT_WEB_ROOT and NEXT_GUEST_WASM to the retained baseline guest");
const digest = "5e37d2afc8d73da8544ba4c1ac32d6c899b85ce1b2325892dd8aa9dcbc4a53bb";
assert.equal(createHash("sha256").update(readFileSync(guest)).digest("hex"), digest);
assert.equal(JSON.parse(readFileSync(join(assets, "engine-builds.json"), "utf8"))["bun-browser.wasm"], digest);
const reports = resolve(process.env.NEXT_REPORTS ?? "/work/tmp/bun-wasm-next-socket-control");
mkdirSync(reports, { recursive: true });
const task = session("next-socket-control-");
const nativeEvents: string[] = [];
const port = Number(process.env.NEXT_SOCKET_PORT ?? "43286");
let page: Page | undefined;
const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(124)); }, 150000);
try {
  const match = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: assets, PORT: process.env.NEXT_WEB_PORT ?? "43285" });
  const browser = await task.launch(playwright.chromium);
  const context = await browser.newContext({ serviceWorkers: "allow" });
  page = await context.newPage();
  await page.goto(`${match[1]}?engine=browser`);
  assert.match(await ready(page), /ready · Browser/);
  await writeFile(page, "/home/user/socket.ts", `const server=Bun.serve({port:${port},hostname:'127.0.0.1',fetch(request){if(new URL(request.url).pathname==='/_next/webpack-hmr' && server.upgrade(request))return;return new Response('<!doctype html><h1>Socket observer probe</h1>',{headers:{'content-type':'text/html'}});},websocket:{message(ws,data){ws.send(data);}}});`);
  await page.evaluate(() => { void (globalThis as Playground).playground.shell.submit("bun run socket.ts"); });
  await page.waitForFunction(port => (globalThis as Playground).playground.previews.serves(port), port, { timeout: 45000 });
  const url = await page.evaluate(port => (globalThis as Playground).playground.previews.url(port), port);
  const preview = await context.newPage();
  await observePreviewSockets(preview);
  preview.on("websocket", socket => nativeEvents.push(socket.url()));
  await preview.goto(url);
  await preview.getByRole("heading", { name: "Socket observer probe" }).waitFor();
  const observed = await preview.evaluate(async () => {
    const socket = new WebSocket(new URL("/_next/webpack-hmr", location.href).href.replace(/^http/, "ws"));
    const value = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("real guest echo");
      socket.onmessage = event => resolve(String(event.data));
      socket.onerror = () => reject(new Error("socket error"));
    });
    const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
    socket.close(1000, "probe complete");
    await closed;
    return { value, url: socket.url, constructor: WebSocket.name };
  });
  const events = await previewSocketEvents(preview);
  assert.equal(observed.value, "real guest echo");
  assert.deepEqual(nativeEvents, [], "MessagePort sockets must not be mistaken for native browser sockets");
  assert.ok(events.some(event => event.url === observed.url && event.type === "open"));
  assert.ok(events.some(event => event.url === observed.url && event.type === "message" && event.data === "real guest echo"));
  assert.ok(events.some(event => event.url === observed.url && event.type === "close"));
  writeFileSync(join(reports, "socket-observer.json"), JSON.stringify({ guest: digest, observed, nativeEvents, events }, null, 2));
  process.stdout.write(JSON.stringify({ observed, nativeEvents, events }) + "\n");
  await preview.close();
} finally {
  clearTimeout(timer);
  try { if (page) await stopForeground(page, 10000); }
  finally { await task.cleanup(); }
}
