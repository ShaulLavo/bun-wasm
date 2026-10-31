import { expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeNativeProductTraffic } from "./app-matrix/product-browser";
import { serverCommand } from "./app-matrix/browser.mjs";

test("native HMR evidence comes from real frames after editing without patching browser events", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: undefined })) return; return new Response("<!doctype html><p>native traffic</p>", { headers: { "content-type": "text/html" } }); },
    websocket: { message(socket, message) { socket.send(message); } },
  });
  let browser: Browser | undefined;
  let traffic: Awaited<ReturnType<typeof observeNativeProductTraffic>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.url.href);
    const dispatch = await page.evaluate(() => EventTarget.prototype.dispatchEvent.toString());
    traffic = await observeNativeProductTraffic(page);
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace("http:", "ws:"));
      Reflect.set(globalThis, "trafficSocket", socket);
      socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Native fixture socket failed"));
    }));
    async function send(payload: string) {
      await page.evaluate(payload => new Promise<void>(resolve => {
        const socket: unknown = Reflect.get(globalThis, "trafficSocket");
        if (!(socket instanceof WebSocket)) throw new Error("Missing native socket");
        socket.addEventListener("message", () => resolve(), { once: true });
        socket.send(payload);
      }), payload);
    }
    const update = JSON.stringify({ type: "update", updates: [{ type: "js-update", path: "/src/app.tsx" }] });
    await send(update);
    expect(await traffic.count()).toBe(0);
    await traffic.beginEdit();
    await send(update);
    expect((await traffic.evidenceSince(0)).map(event => [event.framework, event.event])).toEqual([["vite", "update"]]);
    await page.evaluate(payload => {
      const socket: unknown = Reflect.get(globalThis, "trafficSocket");
      if (!(socket instanceof WebSocket)) throw new Error("Missing native socket");
      socket.dispatchEvent(new MessageEvent("message", { data: payload }));
    }, update);
    expect(await traffic.count()).toBe(1);
    expect(await page.evaluate(() => EventTarget.prototype.dispatchEvent.toString())).toBe(dispatch);
    await traffic.close();
    await send(update);
    expect(await traffic.count()).toBe(1);
  } finally { await traffic?.close(); await browser?.close(); await server.stop(true); }
}, 30_000);

function installKeyboardStopFixture(url: string): void {
  const runButton = document.querySelector<HTMLButtonElement>("#run");
  if (!runButton) throw new Error("Keyboard fixture requires its Run button");
  let end = () => {};
  const shell = {
    running: false, lastExit: 0,
    async submit(text: string) {
      if (text === "echo PROMPT_USABLE") { shell.lastExit = 0; return; }
      shell.running = true;
      runButton.disabled = true;
      await new Promise<void>(resolve => { end = resolve; });
    },
    input() { throw new Error("Direct input cannot prove keyboard stop"); },
  };
  Object.assign(globalThis, { playground: { shell, previews: { ready: "ready", serves: () => shell.running, url: () => url } } });
  document.querySelector(".xterm")?.addEventListener("keydown", event => {
    if (!(event instanceof KeyboardEvent) || !event.ctrlKey || event.key.toLowerCase() !== "c") return;
    event.preventDefault();
    Reflect.set(globalThis, "keyboardStop", { trusted: event.isTrusted, focused: document.activeElement?.className });
    shell.running = false;
    shell.lastExit = 130;
    runButton.disabled = false;
    end();
  });
}

test("matrix cleanup sends a trusted terminal Ctrl-C and waits for status 130", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-keyboard-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("intentional fixture failure", { status: 503 }) });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<button id="run">Run</button><div class="xterm" tabindex="0">Terminal fixture</div>');
    await page.evaluate(installKeyboardStopFixture, server.url.href);
    const result = await serverCommand({ page, context, app: { id: "keyboard-fixture" }, engine: "browser",
      command: { name: "dev", args: ["run", "fixture.ts"], check: { kind: "http", text: "unused" } },
      options: { timeout: 2000, cleanupTimeout: 2000, output: directory }, terminalText: async () => "user@bun:~$ bun run .matrix-command.ts fixture.ts\nfixture output\n",
    });
    expect(result.status).toBe("fail");
    expect("harnessCleanup" in result ? result.harnessCleanup : undefined).toBeUndefined();
    expect(await page.evaluate(() => Reflect.get(globalThis, "keyboardStop"))).toEqual({ trusted: true, focused: "xterm" });
    expect(await page.evaluate(() => { const shell = Reflect.get(Reflect.get(globalThis, "playground"), "shell"); return [shell.running, shell.lastExit]; })).toEqual([false, 130]);
    expect(await page.locator("#run").isEnabled()).toBe(true);
    expect(await page.evaluate(async () => { const shell = Reflect.get(Reflect.get(globalThis, "playground"), "shell"); await shell.submit("echo PROMPT_USABLE"); return shell.lastExit; })).toBe(0);
  } finally { await browser?.close(); await server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 15_000);
