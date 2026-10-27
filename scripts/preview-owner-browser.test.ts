import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import type { Server } from "bun";
import { stoppedPreviewError } from "./app-matrix/server-browser";
import { browserBuildConfig } from "./browser-build";
import { PreviewOwnerHost, type OwnerSession } from "../web/scripts/preview-owner-host";

const isolation = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };

test("real page-owned Waffle relay serves a native HTTP/WebSocket app and revokes on page/runtime close", async () => {
  const host = new PreviewOwnerHost();
  let browser: Browser | undefined;
  let owner: Server<OwnerSession> | undefined;
  let bridge: Server<{ upstream: Socket | null }> | undefined;
  let native: Server<undefined> | undefined;
  let directory: string | undefined;
  const publicRequests: Headers[] = [];
  try {
    directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-owner-"));
    native = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0, websocket: { message(socket, message) { socket.send(message); } },
      async fetch(request, server) {
        publicRequests.push(request.headers);
        const url = new URL(request.url);
        if (url.pathname === "/socket") { if (server.upgrade(request, { data: undefined })) return; return new Response(null, { status: 426 }); }
        if (url.pathname === "/echo") return new Response(await request.text(), { status: 201, headers: { ...isolation, "x-echo": request.headers.get("x-echo") ?? "" } });
        if (url.pathname === "/client.js") return new Response("document.querySelector('#client').textContent=location.pathname;document.querySelector('button').onclick=()=>document.querySelector('output').textContent='1'", { headers: { ...isolation, "content-type": "text/javascript" } });
        return new Response(`<!doctype html><p id="server">${url.pathname}</p><p id="client"></p><button>Count</button><output>0</output><a href="/nested?value=fixture">Nested</a><script type="module" src="/client.js"></script>`, { headers: { ...isolation, "content-type": "text/html" } });
      },
    });
    const target = native.port;
    bridge = Bun.serve<{ upstream: Socket | null }>({ hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (request.headers.get("origin") !== owner?.url.origin) return new Response(null, { status: 403 });
        if (server.upgrade(request, { data: { upstream: null } })) return;
        return new Response(null, { status: 426 });
      }, websocket: {
        open(socket) {
          const upstream = connect(Number(target), "127.0.0.1");
          socket.data.upstream = upstream;
          upstream.on("data", chunk => socket.send(chunk));
          upstream.on("end", () => socket.close());
          upstream.on("error", () => socket.close());
        },
        message(socket, message) { socket.data.upstream?.write(message); },
        close(socket) { socket.data.upstream?.destroy(); },
      },
    });
    const build = await Bun.build(browserBuildConfig([
      join(import.meta.dir, "../web/tests/browser-preview-owner-main.ts"), join(import.meta.dir, "../web/src/fs-worker.ts"),
    ], directory, { splitting: true }));
    expect(build.success).toBe(true);
    const output = directory;
    owner = Bun.serve<OwnerSession>({ hostname: "127.0.0.1", port: 0, websocket: host.websocket,
      async fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (host.handles(path)) return host.fetch(request, server);
        if (path === "/") return new Response('<!doctype html><script type="module" src="/browser-preview-owner-main.js"></script>', { headers: { ...isolation, "content-type": "text/html" } });
        const file = Bun.file(join(output, path));
        return new Response(file, { headers: { ...isolation, "content-type": path.endsWith(".js") ? "text/javascript" : "application/wasm" } });
      },
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    let root = await context.newPage();
    const boot = `${owner.url}?bridge=${encodeURIComponent(bridge.url.href.replace("http:", "ws:"))}`;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(boot);
    await page.waitForFunction(() => Reflect.has(globalThis, "previewOwnerFixture"));
    expect(await page.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").ready())).toBe("ready");
    const url = await page.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").url());
    expect(new URL(url).pathname).toBe("/");
    // Follow the owner page's actual cross-origin link, including Sec-Fetch navigation headers.
    await root.close();
    const opened = context.waitForEvent("page");
    await page.evaluate(url => { window.open(url, "_blank", "noopener"); }, url);
    root = await opened;
    await root.waitForLoadState();
    const response = await root.reload();
    expect(response?.status()).toBe(200);
    expect(response?.fromServiceWorker()).toBe(false);
    expect(await root.locator("#client").textContent()).toBe("/");
    expect(await root.locator("#server").textContent()).toBe("/");
    expect(await root.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await root.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    await root.getByRole("button").click();
    expect(await root.locator("output").textContent()).toBe("1");
    await root.getByRole("link").click();
    await root.waitForURL(`${new URL(url).origin}/nested?value=fixture`);
    await root.reload();
    expect(await root.locator("#client").textContent()).toBe("/nested");
    await root.goBack();
    expect(new URL(root.url()).pathname).toBe("/");
    await root.goForward();
    expect(new URL(root.url()).pathname).toBe("/nested");
    expect(await root.evaluate(async () => {
      const response = await fetch("/echo", { method: "POST", body: "body\u0000fixture", headers: { "x-echo": "challenge" } });
      return [response.status, response.headers.get("x-echo"), await response.text()];
    })).toEqual([201, "challenge", "body\u0000fixture"]);
    const ownerOrigin = owner.url.origin;
    expect(await root.evaluate(async origin => { try { await fetch(`${origin}/__bun_preview_owner/bootstrap`, { method: "POST" }); return true; } catch { return false; } }, ownerOrigin)).toBe(false);
    expect(await context.cookies()).toEqual([]);
    const other = await page.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").url(3138));
    await root.evaluate(() => { document.cookie = "owner_fixture=private; Path=/; SameSite=Strict"; });
    const sibling = await context.newPage();
    await sibling.goto(other);
    expect(await sibling.evaluate(() => document.cookie)).not.toContain("owner_fixture");
    await sibling.close();
    expect(new URL(url).hostname).not.toBe(new URL(other).hostname);
    expect(await root.evaluate(origin => new Promise<boolean>(resolve => {
      const socket = new WebSocket(`${origin.replace("http:", "ws:")}/socket`);
      socket.onopen = () => { socket.close(); resolve(false); };
      socket.onerror = () => resolve(true);
    }), new URL(other).origin)).toBe(true);
    await root.evaluate(() => new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace("http:", "ws:")}/socket`);
      socket.binaryType = "arraybuffer";
      Reflect.set(globalThis, "nativeSocketClosed", false);
      socket.onopen = () => socket.send(new Uint8Array([0, 255, 42]));
      socket.onmessage = event => { if (new Uint8Array(event.data).join() === "0,255,42") resolve(); else reject(new Error("Bad native frame")); };
      socket.onclose = () => Reflect.set(globalThis, "nativeSocketClosed", true);
      socket.onerror = () => reject(new Error("Native socket failed"));
    }));
    await page.close();
    await root.waitForFunction(() => Reflect.get(globalThis, "nativeSocketClosed") === true);
    await root.waitForFunction(async origin => { try { await fetch(origin); return false; } catch { return true; } }, url);
    await root.waitForFunction(async origin => { try { await fetch(origin); return false; } catch { return true; } }, other);
    const replacement = await context.newPage();
    await replacement.goto(boot);
    await replacement.waitForFunction(() => Reflect.has(globalThis, "previewOwnerFixture"));
    expect(await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").ready())).toBe("ready");
    const before = await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").url());
    await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").stop());
    await root.waitForFunction(async origin => { try { await fetch(origin); return false; } catch { return true; } }, before);
    await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").restart());
    expect(await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").ready())).toBe("ready");
    const after = await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").url());
    expect(after).not.toBe(before);
    await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").lateStop());
    expect((await fetch(after)).status).toBe(200);
    await replacement.evaluate(() => Reflect.get(globalThis, "previewOwnerFixture").dispose());
    await root.waitForFunction(async origin => { try { await fetch(origin); return false; } catch { return true; } }, after);
    expect(await stoppedPreviewError(root, after, 2000, join(directory, "stopped.json"), "root")).toBeUndefined();
    expect(publicRequests.every(headers => !headers.has("authorization") && !headers.has("sec-websocket-protocol"))).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
    console.log(JSON.stringify({ stagedWaffleSource: process.env.BUN_WASM_STAGED_WAFFLE_SOURCE, realRelay: true,
      nativeHTTP: true, nativeWebSocket: true, rootPaths: true, rootRelativeModule: true, historyReload: true,
      publicAuthDenied: true, cookieIsolation: true, foreignPortSocketDenied: true, pageCloseRevokes: true, runtimeDisposeRevokes: true, portReuseLateClose: true }));
  } finally {
    await browser?.close();
    await host.close();
    await owner?.stop(true);
    await bridge?.stop(true);
    await native?.stop(true);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
