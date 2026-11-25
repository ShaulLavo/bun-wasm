// Previews on their own origins (docs/preview-origins.md), in real browsers against a real guest:
// the app owns `/`, keeps its own cookies, reloads at a pushed path, hot-reloads over a WebSocket,
// and a second tab of the workspace previews the first tab's server. Preview documents are read
// through a postMessage probe in the app (PROBE below), never through the browser driver's frames.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright";
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

/**
 * Runs inside a preview document and answers questions sent to it with postMessage. Playwright does
 * not see every preview frame (in Firefox a cross-site frame never, a service-worker-served frame
 * not reliably), and a message is also all the IDE itself can exchange with a preview. The tests
 * put this into the app under test: the fixture server's page, or the template's entry file.
 */
const PROBE = `(() => { if (window.__previewProbe) return; window.__previewProbe = true; addEventListener("message", event => { const data = event.data; if (!data || typeof data.__previewProbe !== "number") return; Promise.resolve().then(() => (0, eval)(data.code)).then(value => event.source.postMessage({ __previewProbeReply: data.__previewProbe, value }, "*"), error => event.source.postMessage({ __previewProbeReply: data.__previewProbe, error: String(error) }, "*")); }); })();`;

interface ProbeReply { value?: unknown; error?: string; missing?: true }

/** One question to the page's preview frame: `read` runs there with `argument`. */
function askPreview(page: Page, read: (argument: never) => unknown, argument?: unknown): Promise<ProbeReply> {
  const code = `(${read.toString()})(${JSON.stringify(argument ?? null)})`;
  return page.evaluate(source => new Promise<ProbeReply>(resolve => {
    // The sandbox's preview frame, or the one frame of a new-tab wrapper page.
    const frame = document.querySelector<HTMLIFrameElement>("iframe#preview") ?? document.querySelector<HTMLIFrameElement>("iframe:not([aria-hidden])");
    const id = Math.random();
    const finish = (reply: ProbeReply) => {
      clearTimeout(timer);
      removeEventListener("message", receive);
      resolve(reply);
    };
    const receive = (event: MessageEvent<{ __previewProbeReply?: number; value?: unknown; error?: string } | null>) => {
      if (event.source !== frame?.contentWindow || event.data?.__previewProbeReply !== id) return;
      finish(event.data.error === undefined ? { value: event.data.value } : { error: event.data.error });
    };
    const timer = setTimeout(() => finish({ missing: true }), 3_000);
    addEventListener("message", receive);
    frame?.contentWindow?.postMessage({ __previewProbe: id, code: source }, "*");
  }), code);
}

/** Asks the preview until an answer satisfies `accept`. Documents come and go across reloads. */
async function inPreview<T, A = undefined>(page: Page, read: (argument: A) => T | Promise<T>, what: string, options: { argument?: A; accept?: (value: T) => boolean; timeout?: number } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeout ?? 120_000);
  let last: ProbeReply = { missing: true };
  while (Date.now() < deadline) {
    last = await askPreview(page, read as (argument: never) => unknown, options.argument).catch(error => ({ error: String(error) }));
    if (last.missing === undefined && last.error === undefined && (options.accept?.(last.value as T) ?? true)) return last.value as T;
    await page.waitForTimeout(100);
  }
  throw new Error(`${what}: last answer ${JSON.stringify(last).slice(0, 400)}`);
}

/** Waits until the preview's body shows `needle`. */
function previewShowing(page: Page, needle: string, timeout = 120_000): Promise<string> {
  return inPreview(page, () => document.body?.innerText ?? "", `preview never showed ${JSON.stringify(needle)}`, { accept: text => text.includes(needle), timeout });
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

/** Adds the probe to the template's entry file, as an app author could, and waits until the preview answers. */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(async (probe) => {
    const api = Reflect.get(globalThis, "sandbox");
    const current = api.editor.view.state.doc.toString();
    if (!current.includes("__previewProbe")) api.editor.setText(`${current}\n${probe}\n`);
    await api.editor.flush(api.editor.path);
  }, PROBE);
  await inPreview(page, () => true, "the preview never answered the probe");
}

async function sandboxFrameSrc(page: Page): Promise<URL> {
  return new URL((await page.locator("#preview").getAttribute("src")) ?? "about:blank");
}

function trackErrors(page: Page, label: string, errors: string[]): void {
  page.on("pageerror", error => errors.push(`${label}: ${error.message}\n${error.stack ?? ""}`));
}

/** Clicks the Vite counter, edits the source, and requires the edit to arrive without a reload. */
async function expectHotReload(page: Page, marker: string): Promise<void> {
  await previewShowing(page, "count is 0");
  await inPreview(page, () => {
    const counter = document.querySelector<HTMLButtonElement>("button.counter");
    if (counter?.textContent === "count is 0") counter.click();
    return counter?.textContent ?? "";
  }, "the counter never counted", { accept: text => text === "count is 1" });
  await inPreview(page, () => { Reflect.set(globalThis, "__sameDocument", true); return true; }, "the preview never took the marker");
  await editSandboxFile(page, marker);
  await previewShowing(page, marker);
  // Hot module replacement, not a reload: the document and its counter state survive.
  expect(await inPreview(page, () => ({ same: Reflect.get(globalThis, "__sameDocument") === true, counter: document.querySelector("button.counter")?.textContent }), "no state after the edit")).toEqual({ same: true, counter: "count is 1" });
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
const probe = ${JSON.stringify(PROBE)};
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
    return new Response('<!doctype html><title>' + name + '</title><script>' + probe + '</script><h1 id="path">path:' + url.pathname + '</h1><p id="asset"></p><p id="api"></p><img id="logo" src="/logo.svg"><script src="/assets/app.js"></script>', { headers });
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

function text(page: Page, selector: string, expected: string): Promise<string | null> {
  return inPreview(page, (query: string) => document.querySelector(query)?.textContent ?? null, `${selector} never became ${JSON.stringify(expected)}`, { argument: selector, accept: value => value === expected });
}

interface RequestEcho { cookie: string; host: string; origin: string }
function requestEcho(page: Page, method = "GET"): Promise<RequestEcho> {
  return inPreview(page, async (verb: string) => (await fetch("/api/request", { method: verb })).json() as Promise<RequestEcho>, "request echo failed", { argument: method });
}

const sorted = (cookies: string) => cookies.split("; ").sort();

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
      await installProbe(owner);
      // The app sees its real path and origin: no mount prefix anywhere.
      expect(await inPreview(owner, () => ({ path: location.pathname, origin: location.origin }), "no location")).toEqual({ path: "/", origin: src.origin });
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
      await inPreview(follower, () => { history.pushState({}, "", "/dashboard"); location.reload(); return true; }, "the follower never started its reload");
      await inPreview(follower, () => ({ path: location.pathname, loaded: document.readyState === "complete", reloaded: performance.getEntriesByType("navigation").some(entry => (entry as PerformanceNavigationTiming).type === "reload") }), "the follower never reloaded at /dashboard", { accept: state => state.path === "/dashboard" && state.loaded && state.reloaded });
      await previewShowing(follower, second);
      // The owner's hot-reload socket ran from its page to the IDE directly, so it is still connected:
      // a further edit arrives in the same document.
      const third = `preview-origin-after-loss-${browserName}-${Date.now()}`;
      await editSandboxFile(owner, third);
      await Promise.all([previewShowing(owner, third), previewShowing(follower, third)]);
      expect(await inPreview(owner, () => Reflect.get(globalThis, "__sameDocument") === true, "no owner state")).toBe(true);
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
      expect(await inPreview(tab, () => { const logo = document.querySelector<HTMLImageElement>("#logo"); return logo?.complete ? logo.naturalWidth : 0; }, "logo never loaded", { accept: width => width > 0 })).toBe(8);

      // The server's cookies come back on the next request; only the script-visible one reaches the page.
      const origin = await inPreview(tab, () => location.origin, "no origin");
      const echoed = await requestEcho(tab);
      expect(sorted(echoed.cookie)).toEqual(["sid=secret-one", "theme=dark-one"]);
      expect(echoed.host).toBe(new URL(origin).host);
      expect(await inPreview(tab, () => document.cookie, "no cookie string")).toBe("theme=dark-one");
      expect((await requestEcho(tab, "POST")).origin).toBe(origin);

      // A script write is applied before the very next request leaves.
      const written = await inPreview(tab, async () => {
        document.cookie = "client=1; Path=/";
        const echo = (await (await fetch("/api/request")).json()) as { cookie: string };
        return { now: document.cookie, sent: echo.cookie };
      }, "cookie write failed");
      expect(sorted(written.now)).toEqual(["client=1", "theme=dark-one"]);
      expect(sorted(written.sent)).toEqual(["client=1", "sid=secret-one", "theme=dark-one"]);

      // A WebSocket to the app's own origin reaches the server.
      expect(await inPreview(tab, () => new Promise<string>((done, fail) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
        socket.onopen = () => socket.send("ping");
        socket.onmessage = event => { done(String(event.data)); socket.close(); };
        socket.onerror = () => fail(new Error("socket error"));
      }), "socket echo failed")).toBe("echo:ping");

      // A pushed path survives a reload: the server gets that path and the cookies with it.
      await inPreview(tab, () => { history.pushState({}, "", "/dashboard"); location.reload(); return true; }, "reload failed");
      await text(tab, "#path", "path:/dashboard");
      expect(await inPreview(tab, async () => (await (await fetch("/api/log")).json()) as string[], "no log")).toContain("one GET /dashboard");
      expect(sorted(await inPreview(tab, () => document.cookie, "no cookie string"))).toEqual(["client=1", "theme=dark-one"]);
      // The wrapper page follows the preview, so reloading the tab returns to the same place.
      await tab.waitForFunction(() => new URL(new URLSearchParams(location.search).get("url") ?? "about:blank").pathname === "/dashboard", null, { timeout: 30_000 });

      // A second port is another origin: it has its own cookies and sees none of the first's.
      const other = await openLink(context, two, errors, "preview two");
      await text(other, "#api", "hello-from-two");
      expect(sorted((await requestEcho(other)).cookie)).toEqual(["sid=secret-two", "theme=dark-two"]);
      expect(await inPreview(other, () => document.cookie, "no cookie string")).toBe("theme=dark-two");

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
      await installProbe(page);
      await expectHotReload(page, `preview-origin-cross-${browserName}-${Date.now()}`);

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
      await installProbe(page);
      await expectHotReload(page, `preview-origin-public-${Date.now()}`);
      expect(errors).toEqual([]);
    });
  });
}
