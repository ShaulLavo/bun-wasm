// Previews on their own origins (docs/preview-origins.md), in real browsers against a real guest:
// the app owns `/`, keeps its own cookies, reloads at a pushed path, hot-reloads over a WebSocket,
// and a second tab of the workspace previews the first tab's server.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Frame, type LaunchOptions, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

// Tests here start real processes and browsers. The limit only catches a hang.
setDefaultTimeout(480_000);

const requested = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
const exactBrowsers = process.env.BUN_WASM_STORAGE_EXACT_BROWSERS === "1";
const browsers = Array.from(
  new Set(requested.flatMap((name) => (!exactBrowsers && name === "chromium" ? ["chromium", "firefox"] : [name]))),
);
const PREVIEW_HOST = /^[a-z2-7]{52}-(\d{1,5})-pv\./;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/**
 * Where the IDE and its previews live.
 * - `same`: `ide.bunwasm.localhost` and `<id>-<port>-pv.bunwasm.localhost`, one site, as in production.
 * - `cross`: `localhost` and `<id>-<port>-pv.localhost`, two sites, with the browser's real storage partitioning.
 * - `public`: `bun.bunwasm-preview.test` and `<id>-<port>-pv.bunwasm-preview.test` over HTTPS: names no dev
 *   server treats as loopback. Chromium only: it alone resolves a made-up name without a proxy, and it lets a
 *   service worker load behind a throwaway certificate.
 */
type Layout = "same" | "cross" | "public";

// Playwright 1.64.1 turns storage partitioning off (chromiumSwitches.ts disabledFeatures, in order).
// Real Chrome partitions a cross-site frame's service worker, so the cross-site layout puts it back.
const PLAYWRIGHT_DISABLED = [
  "AvoidUnnecessaryBeforeUnloadCheckSync", "DestroyProfileOnBrowserClose", "DialMediaRouteProvider",
  "GlobalMediaControls", "HttpsUpgrades", "LensOverlay", "MediaRouter", "PaintHolding",
  "ThirdPartyStoragePartitioning", "BlockOriginHeaderModificationOnRedirect", "AvoidCorsURLLoaderRestartOnRedirect",
  "Translate", "AutoDeElevate", "OptimizationHints", "NetworkTimeServiceQuerying", "AimEnabled",
  "msForceBrowserSignIn", "msEdgeUpdateLaunchServicesPreferredVersion",
];
const PUBLIC_DOMAIN = "bunwasm-preview.test";

function serveEnv(layout: Layout): Record<string, string> {
  if (layout === "same") return { PREVIEW_ORIGIN_HOST: "bunwasm.localhost", PREVIEW_IDE_HOSTS: "ide.bunwasm.localhost" };
  if (layout === "public") return { PREVIEW_ORIGIN_HOST: PUBLIC_DOMAIN, PREVIEW_IDE_HOSTS: `bun.${PUBLIC_DOMAIN}` };
  return {};
}

function launchOptions(layout: Layout, browserName: string): LaunchOptions {
  if (layout === "public") return { args: [`--host-resolver-rules=MAP *.${PUBLIC_DOMAIN} 127.0.0.1`, "--ignore-certificate-errors"] };
  if (layout !== "cross") return {};
  if (browserName === "firefox") return { firefoxUserPrefs: { "network.cookie.cookieBehavior": 5 } };
  if (browserName !== "chromium") return {};
  return {
    ignoreDefaultArgs: [`--disable-features=${PLAYWRIGHT_DISABLED.join(",")}`],
    args: [`--disable-features=${PLAYWRIGHT_DISABLED.filter(feature => feature !== "ThirdPartyStoragePartitioning").join(",")}`],
  };
}

/** A self-signed certificate for the made-up public names. The browser is told to ignore who signed it. */
function throwawayCertificate(scratch: string): { TLS_CERT: string; TLS_KEY: string } {
  const files = { TLS_CERT: join(scratch, "preview-origins-cert.pem"), TLS_KEY: join(scratch, "preview-origins-key.pem") };
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
    "-keyout", files.TLS_KEY, "-out", files.TLS_CERT, "-subj", `/CN=${PUBLIC_DOMAIN}`, "-addext", `subjectAltName=DNS:*.${PUBLIC_DOMAIN}`,
  ], { stdio: "ignore", timeout: 30_000 });
  return files;
}

/** The IDE page's URL for an app path and query. */
function ideUrl(layout: Layout, served: URL, path: string, query = ""): string {
  const prefix = query ? `${query}&` : "";
  if (layout === "same") return `http://ide.bunwasm.localhost:${served.port}${path}?${prefix}preview-origin=bunwasm.localhost:${served.port}`;
  if (layout === "public") return `https://bun.${PUBLIC_DOMAIN}:${served.port}${path}?${prefix}preview-origin=${PUBLIC_DOMAIN}:${served.port}`;
  return `http://localhost:${served.port}${path}?${prefix}preview-origin`;
}

/** A development run may name an unverified site directory; CI always consumes the verified producer artifact. */
function siteDirectory(): { root: string; verify: string | null } {
  const development = process.env.BUN_WASM_PREVIEW_ORIGINS_DEV_SITE;
  if (development && process.env.CI) throw new Error("CI must consume the verified browser-guest producer artifact");
  if (development) return { root: resolve(development), verify: null };
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (!provided) throw new Error("Provide BUN_WASM_BROWSER_SITE. This consumer never builds a guest or site.");
  return { root: join(resolve(provided), "site"), verify: resolve(provided) };
}

async function withSite(browserName: string, layout: Layout, run: (context: BrowserContext, served: URL, browser: Browser) => Promise<void>): Promise<void> {
  const engine = { chromium, firefox, webkit }[browserName];
  if (!engine) throw new Error(`Unsupported browser ${browserName}`);
  const { root, verify } = siteDirectory();
  const before = verify ? await verifySite(verify) : null;
  const task = session("bun-wasm-preview-origins-");
  cleanups.push(() => task.cleanup());
  const env: Record<string, string> = { PORT: process.env.BUN_WASM_TEST_PORT ?? "0", ROOT: root, PREVIEW_ORIGIN_HOST: "", PREVIEW_IDE_HOSTS: "", ...serveEnv(layout) };
  if (layout === "public") Object.assign(env, throwawayCertificate(task.scratch));
  const started: RegExpExecArray = await task.start(["serve.ts"], /at (https?:\/\/\S+) \(cross-origin isolated\)/, env);
  const served = new URL(started[1]!);
  const browser = await engine.launch({ headless: true, ...launchOptions(layout, browserName) });
  cleanups.push(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: layout === "public" });
  cleanups.push(() => context.close());
  await run(context, served, browser);
  if (verify && before) expect(await verifySite(verify)).toEqual(before);
}

async function waitForSandboxReady(page: Page, timeout = 180_000): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const api = Reflect.get(globalThis, "sandbox");
        const status = document.querySelector("#status");
        if (status?.getAttribute("data-kind") === "error") throw new Error(`Sandbox error: ${status.textContent}`);
        return Boolean(api?.editor?.path) && document.querySelector("#server-dot")?.getAttribute("data-state") === "up";
      },
      null,
      { timeout },
    );
  } catch (error) {
    const diagnosis = await page.evaluate(() => ({
      role: Reflect.get(globalThis, "sandbox")?.role?.() ?? null,
      serverDot: document.querySelector("#server-dot")?.getAttribute("data-state") ?? null,
      previewUrl: document.querySelector("#preview-url")?.textContent ?? null,
      status: document.querySelector("#status")?.textContent ?? null,
    })).catch(() => null);
    throw new Error(`${String(error)} | sandbox=${JSON.stringify(diagnosis)}`);
  }
}

function isPreviewDocument(frame: Frame): boolean {
  let url: URL;
  try { url = new URL(frame.url()); } catch { return false; }
  return PREVIEW_HOST.test(url.hostname) && !url.pathname.startsWith("/__bunwasm-preview/");
}

/** Polls the page's preview frame until `read` returns a value. Frames come and go across reloads. */
async function inPreview<T>(page: Page, read: (frame: Frame) => Promise<T | undefined>, what: string, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last = "no preview frame";
  while (Date.now() < deadline) {
    const frame = page.frames().find(isPreviewDocument);
    try {
      const value = frame ? await read(frame) : undefined;
      if (value !== undefined) return value;
      if (frame) last = (await frame.evaluate(() => `${location.href} :: ${document.body?.innerText.slice(0, 300) ?? ""}`));
    } catch (error) {
      last = String(error).slice(0, 200);
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`${what}: ${last} | frames: ${page.frames().map(frame => frame.url()).join(", ")}`);
}

/** The preview frame once its body shows `needle`. */
function previewShowing(page: Page, needle: string, timeout = 120_000): Promise<Frame> {
  return inPreview(page, async frame => ((await frame.evaluate(() => document.body?.innerText ?? "")).includes(needle) ? frame : undefined), `preview never showed ${JSON.stringify(needle)}`, timeout);
}

async function editSandboxFile(page: Page, marker: string): Promise<void> {
  await page.evaluate(async (text) => {
    const api = Reflect.get(globalThis, "sandbox");
    const current = api.editor.view.state.doc.toString();
    api.editor.setText(current.includes("Hello from vanilla TypeScript")
      ? current.replace("Hello from vanilla TypeScript", text)
      : current.replace(/<h1>[^<]*<\/h1>/, `<h1>${text}</h1>`));
    await api.editor.flush(api.editor.path);
  }, marker);
}

async function sandboxFrameSrc(page: Page): Promise<URL> {
  return new URL((await page.locator("#preview").getAttribute("src")) ?? "about:blank");
}

function trackErrors(page: Page, label: string, errors: string[]): void {
  page.on("pageerror", error => errors.push(`${label}: ${error.message}`));
}

/** Clicks the Vite counter, edits the source, and requires the edit to arrive without a reload. */
async function expectHotReload(page: Page, marker: string): Promise<void> {
  const frame = await previewShowing(page, "count is 0");
  await frame.locator("button.counter").click();
  await previewShowing(page, "count is 1");
  await frame.evaluate(() => { Reflect.set(globalThis, "__sameDocument", true); });
  await editSandboxFile(page, marker);
  const updated = await previewShowing(page, marker);
  expect(await updated.evaluate(() => Reflect.get(globalThis, "__sameDocument"))).toBe(true);
  expect(await updated.locator("button.counter").textContent()).toBe("count is 1");
}

/** Makes the preview's service worker lose its port: a real stop where the browser has one, a dropped channel elsewhere. */
async function loseServiceWorkerPort(browserName: string, owner: Page, port: number): Promise<void> {
  if (browserName === "chromium") {
    const cdp = await owner.context().newCDPSession(owner);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await cdp.detach();
    return;
  }
  await owner.evaluate((listening) => Reflect.get(globalThis, "sandbox").previews.dropAttachment(listening), port);
}

const SERVER = `
const log: string[] = [];
function app(name: string) {
  return (req: Request, server: { upgrade(req: Request): boolean }) => {
    const url = new URL(req.url);
    log.push(name + " " + req.method + " " + url.pathname);
    if (url.pathname === "/ws") return server.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
    if (url.pathname === "/assets/app.js") {
      return new Response('document.querySelector("#asset").textContent = "asset-ok"; fetch("/api/hello").then(r => r.json()).then(v => { document.querySelector("#api").textContent = v.message; });', { headers: { "content-type": "text/javascript" } });
    }
    if (url.pathname === "/logo.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', { headers: { "content-type": "image/svg+xml" } });
    if (url.pathname === "/api/hello") return Response.json({ message: "hello-from-" + name });
    if (url.pathname === "/api/request") return Response.json({ cookie: req.headers.get("cookie") ?? "", host: req.headers.get("host") ?? "", origin: req.headers.get("origin") ?? "" });
    if (url.pathname === "/api/log") return Response.json(log);
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/") {
      headers.append("set-cookie", "sid=secret-" + name + "; Path=/; HttpOnly");
      headers.append("set-cookie", "theme=dark-" + name + "; Path=/");
    }
    return new Response('<!doctype html><title>' + name + '</title><h1 id="path">path:' + url.pathname + '</h1><p id="asset"></p><p id="api"></p><img id="logo" src="/logo.svg"><script src="/assets/app.js"></script>', { headers });
  };
}
const websocket = { message(socket: { send(text: string): void }, message: string | Uint8Array) { socket.send("echo:" + String(message)); } };
Bun.serve({ port: 3000, fetch: app("one"), websocket });
Bun.serve({ port: 3001, fetch: app("two"), websocket });
console.log("servers-listening");
`;

interface PlaygroundApi {
  editor?: { path?: string };
  fs: { writeFile(path: string, data: string): Promise<void>; flush(): Promise<void> };
  shell: { submit(command: string): Promise<void> };
  term?: { buffer?: { active?: { length: number; getLine(index: number): { isWrapped?: boolean; translateToString(trim: boolean): string } | undefined } } };
}

/** Starts the two fixture servers in the playground and returns their new-tab links, by port. */
async function startPlaygroundServers(page: Page): Promise<Map<number, URL>> {
  await page.waitForFunction(() => {
    const playground = Reflect.get(globalThis, "playground") as unknown as PlaygroundApi | undefined;
    return playground?.editor?.path === "/home/user/index.ts" && document.querySelector("#status")?.getAttribute("data-kind") === "ok";
  }, null, { timeout: 120_000 });
  await page.evaluate(async (source) => {
    const playground = Reflect.get(globalThis, "playground") as unknown as PlaygroundApi;
    await playground.fs.writeFile("/home/user/preview-origins-server.ts", source);
    await playground.fs.flush();
    void playground.shell.submit("bun run /home/user/preview-origins-server.ts");
  }, SERVER);
  const links = await page.waitForFunction(() => {
    const buffer = (Reflect.get(globalThis, "playground") as unknown as PlaygroundApi | undefined)?.term?.buffer?.active;
    if (!buffer) return null;
    let text = "";
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (line) text += (index > 0 && !line.isWrapped ? "\n" : "") + line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    }
    const found = Array.from(text.matchAll(/\[preview\] (https?:\/\/\S+)/g), match => match[1]!);
    return found.length >= 2 ? found : null;
  }, null, { timeout: 120_000 });
  const byPort = new Map<number, URL>();
  for (const link of await links.jsonValue() as string[]) {
    const target = new URL(new URL(link).searchParams.get("url") ?? "about:blank");
    byPort.set(Number(PREVIEW_HOST.exec(target.hostname)?.[1]), new URL(link));
  }
  return byPort;
}

/** Opens a new-tab link (the IDE-origin wrapper page) and returns the tab. */
async function openLink(context: BrowserContext, link: URL, errors: string[], label: string): Promise<Page> {
  const page = await context.newPage();
  trackErrors(page, label, errors);
  await navigateTestPage(page, link.href);
  return page;
}

function text(page: Page, selector: string, expected: string): Promise<true> {
  return inPreview(page, async frame => ((await frame.locator(selector).textContent().catch(() => null)) === expected ? true : undefined), `${selector} never became ${JSON.stringify(expected)}`);
}

interface RequestEcho { cookie: string; host: string; origin: string }
function requestEcho(page: Page, init?: { method: string }): Promise<RequestEcho> {
  return inPreview(page, frame => frame.evaluate(async (options) => (await fetch("/api/request", options)).json() as Promise<RequestEcho>, init), "request echo failed");
}

for (const browserName of browsers) {
  test(`${browserName}: a Vite app hot-reloads on its own origin, a second tab previews it, and a lost port recovers`, async () => {
    await withSite(browserName, "same", async (context, served) => {
      const errors: string[] = [];
      const owner = await context.newPage();
      trackErrors(owner, "owner", errors);
      await navigateTestPage(owner, ideUrl("same", served, "/sandbox/", "template=vanilla"));
      await waitForSandboxReady(owner);
      expect(await owner.evaluate(() => Reflect.get(globalThis, "sandbox").role())).toBe("owner");

      const src = await sandboxFrameSrc(owner);
      expect(PREVIEW_HOST.exec(src.hostname)?.[1]).toBe("5173");
      const frame = await previewShowing(owner, "count is 0");
      // The app sees its real path and origin: no mount prefix anywhere.
      expect(await frame.evaluate(() => ({ path: location.pathname, origin: location.origin }))).toEqual({ path: "/", origin: src.origin });
      const first = `preview-origin-hmr-${browserName}-${Date.now()}`;
      await expectHotReload(owner, first);

      // A second tab of the same workspace previews the first tab's server on the same origin.
      const follower = await context.newPage();
      trackErrors(follower, "follower", errors);
      await navigateTestPage(follower, ideUrl("same", served, "/sandbox/", "template=vanilla"));
      await waitForSandboxReady(follower);
      expect(await follower.evaluate(() => Reflect.get(globalThis, "sandbox").role())).toBe("follower");
      expect((await sandboxFrameSrc(follower)).href).toBe(src.href);
      await previewShowing(follower, first);
      const second = `preview-origin-shared-${browserName}-${Date.now()}`;
      await editSandboxFile(owner, second);
      await Promise.all([previewShowing(owner, second), previewShowing(follower, second)]);

      // The service worker loses its port. The follower's next navigation gets a new one through the owner's relay.
      await loseServiceWorkerPort(browserName, owner, 5173);
      const reloading = await previewShowing(follower, second);
      await reloading.evaluate(() => { history.pushState({}, "", "/dashboard"); location.reload(); }).catch(() => {});
      const reloaded = await inPreview(follower, async candidate => ((await candidate.evaluate(() => location.pathname)) === "/dashboard" ? candidate : undefined), "the follower never reloaded at /dashboard");
      expect(await reloaded.evaluate(() => document.body.innerText)).toContain(second);
      expect(errors).toEqual([]);
    });
  });

  test(`${browserName}: an app owns "/" on its preview origin with its own cookies, apart from the IDE and a second port`, async () => {
    await withSite(browserName, "same", async (context, served) => {
      const errors: string[] = [];
      const ide = await context.newPage();
      trackErrors(ide, "playground", errors);
      await navigateTestPage(ide, ideUrl("same", served, "/"));
      const links = await startPlaygroundServers(ide);
      const one = links.get(3000);
      const two = links.get(3001);
      if (!one || !two) throw new Error(`Missing preview links: ${JSON.stringify(Array.from(links))}`);
      // A new-tab link is an IDE-origin page that frames the preview.
      expect(one.origin).toBe(new URL(ide.url()).origin);

      const tab = await openLink(context, one, errors, "preview one");
      // Root-relative script, image and fetch all reach the server at "/".
      await text(tab, "#path", "path:/");
      await text(tab, "#asset", "asset-ok");
      await text(tab, "#api", "hello-from-one");
      expect(await inPreview(tab, frame => frame.evaluate(() => { const logo = document.querySelector<HTMLImageElement>("#logo"); return logo?.complete ? logo.naturalWidth : undefined; }), "logo never loaded")).toBe(8);

      // The server's cookies come back on the next request; only the script-visible one reaches the page.
      const origin = await inPreview(tab, frame => frame.evaluate(() => location.origin), "no origin");
      const echoed = await requestEcho(tab);
      expect(echoed.cookie.split("; ").sort()).toEqual(["sid=secret-one", "theme=dark-one"]);
      expect(echoed.host).toBe(new URL(origin).host);
      expect(await inPreview(tab, frame => frame.evaluate(() => document.cookie), "no cookie string")).toBe("theme=dark-one");
      expect((await requestEcho(tab, { method: "POST" })).origin).toBe(origin);

      // A script write is applied before the very next request leaves.
      const written = await inPreview(tab, frame => frame.evaluate(async () => {
        document.cookie = "client=1; Path=/";
        const echoed = (await (await fetch("/api/request")).json()) as { cookie: string };
        return { now: document.cookie, sent: echoed.cookie };
      }), "cookie write failed");
      expect(written.now.split("; ").sort()).toEqual(["client=1", "theme=dark-one"]);
      expect(written.sent.split("; ").sort()).toEqual(["client=1", "sid=secret-one", "theme=dark-one"]);

      // A WebSocket to the app's own origin reaches the server.
      expect(await inPreview(tab, frame => frame.evaluate(() => new Promise<string>((done, fail) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
        socket.onopen = () => socket.send("ping");
        socket.onmessage = event => { done(String(event.data)); socket.close(); };
        socket.onerror = () => fail(new Error("socket error"));
      })), "socket echo failed")).toBe("echo:ping");

      // A pushed path survives a reload: the server gets that path and the cookies with it.
      await inPreview(tab, frame => frame.evaluate(() => { history.pushState({}, "", "/dashboard"); location.reload(); return true; }), "reload failed");
      await text(tab, "#path", "path:/dashboard");
      expect(await inPreview(tab, frame => frame.evaluate(async () => (await (await fetch("/api/log")).json()) as string[]), "no log")).toContain("one GET /dashboard");
      expect((await inPreview(tab, frame => frame.evaluate(() => document.cookie), "no cookie string")).split("; ").sort()).toEqual(["client=1", "theme=dark-one"]);
      // The wrapper page follows the preview, so reloading the tab returns to the same place.
      await tab.waitForFunction(() => new URL(new URLSearchParams(location.search).get("url") ?? "about:blank").pathname === "/dashboard", null, { timeout: 30_000 });

      // A second port is another origin: it has its own cookies and sees none of the first's.
      const other = await openLink(context, two, errors, "preview two");
      await text(other, "#api", "hello-from-two");
      expect((await requestEcho(other)).cookie.split("; ").sort()).toEqual(["sid=secret-two", "theme=dark-two"]);
      expect(await inPreview(other, frame => frame.evaluate(() => document.cookie), "no cookie string")).toBe("theme=dark-two");

      // Nothing reached the IDE origin, or the browser's own cookie store at all.
      expect(await ide.evaluate(() => document.cookie)).toBe("");
      expect((await context.cookies()).filter(cookie => /^(?:sid|theme|client)$/.test(cookie.name))).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  test(`${browserName}: previews work from another site, where a tab on the preview origin itself cannot reach the IDE`, async () => {
    await withSite(browserName, "cross", async (context, served) => {
      const errors: string[] = [];
      const page = await context.newPage();
      trackErrors(page, "sandbox", errors);
      await navigateTestPage(page, ideUrl("cross", served, "/sandbox/", "template=vanilla&mode=memory"));
      await waitForSandboxReady(page);
      const src = await sandboxFrameSrc(page);
      expect(PREVIEW_HOST.exec(src.hostname)?.[1]).toBe("5173");
      // The sandbox reports "ready" only on the preview document's own word that it loaded.
      await page.waitForFunction(() => /dev server ready/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 120_000 });
      // Playwright cannot look inside a cross-site frame in Firefox, so the frame itself is checked elsewhere.
      if (browserName !== "firefox") await expectHotReload(page, `preview-origin-cross-${browserName}-${Date.now()}`);

      // The frame's service worker belongs to the IDE's site. A tab on the preview origin has none and says so.
      const direct = await context.newPage();
      await navigateTestPage(direct, src.href);
      await direct.waitForFunction(() => (document.body?.innerText ?? "").includes("only works inside its IDE tab"), null, { timeout: 60_000 });
      expect(errors).toEqual([]);
    });
  });
}

if (browsers.includes("chromium")) {
  test("chromium: Vite accepts a preview hostname that is not a loopback name", async () => {
    await withSite("chromium", "public", async (context, served) => {
      const errors: string[] = [];
      const page = await context.newPage();
      trackErrors(page, "sandbox", errors);
      await navigateTestPage(page, ideUrl("public", served, "/sandbox/", "template=vanilla&mode=memory"));
      await waitForSandboxReady(page);
      const src = await sandboxFrameSrc(page);
      expect(src.hostname.endsWith(`-5173-pv.${PUBLIC_DOMAIN}`)).toBe(true);
      // Vite answers 403 "Blocked request" to a Host name it does not know. It knows this one.
      await expectHotReload(page, `preview-origin-public-${Date.now()}`);
      expect(errors).toEqual([]);
    });
  });
}
