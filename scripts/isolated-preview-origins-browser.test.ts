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
 * - `public`: `bun.bunwasm-preview.test` and `<id>-<port>-pv.bunwasm-preview.test` over HTTPS on the default
 *   port, as in production: names no dev server treats as loopback. Chromium only: it alone resolves a
 *   made-up name (and maps port 443 to the server's own) without a proxy, and it lets a service worker load
 *   behind a throwaway certificate.
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
  if (layout === "public") return { PREVIEW_ORIGIN_HOST: PUBLIC_DOMAIN, PREVIEW_IDE_HOSTS: `bun.${PUBLIC_DOMAIN}`, PREVIEW_PUBLIC_PORT: "443" };
  return {};
}

function launchOptions(layout: Layout, browserName: string, served: URL): LaunchOptions {
  // Every port of the made-up names, 443 included, is the test server.
  if (layout === "public") return { args: [`--host-resolver-rules=MAP *.${PUBLIC_DOMAIN} 127.0.0.1:${served.port}`, "--ignore-certificate-errors"] };
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
  if (layout === "public") return `https://bun.${PUBLIC_DOMAIN}${path}?${prefix}preview-origin=${PUBLIC_DOMAIN}`;
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
  const env: Record<string, string> = { PORT: process.env.BUN_WASM_TEST_PORT ?? "0", ROOT: root, PREVIEW_ORIGIN_HOST: "", PREVIEW_IDE_HOSTS: "", PREVIEW_PUBLIC_PORT: "", ...serveEnv(layout) };
  if (layout === "public") Object.assign(env, throwawayCertificate(task.scratch));
  const started: RegExpExecArray = await task.start(["serve.ts"], /at (https?:\/\/\S+) \(cross-origin isolated\)/, env);
  const served = new URL(started[1]!);
  const browser = await engine.launch({ headless: true, ...launchOptions(layout, browserName, served) });
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
    return new Response('<!doctype html><title>' + name + '</title><script>' + probe + '</script><h1 id="path">path:' + url.pathname + '</h1><p><a id="blank" href="/report?from=link" target="_blank">report</a> <button id="open" onclick="window.open(\\'/report?from=open\\')">print</button> <button id="window" onclick="window.open(\\'/report?from=window\\', \\'\\', \\'width=600,height=400\\')">window</button></p><p id="asset"></p><p id="api"></p><img id="logo" src="/logo.svg"><script src="/assets/app.js"></script>', { headers });
  };
}
const websocket = { message(socket: { send(text: string): void }, message: string | Uint8Array) { socket.send("echo:" + String(message)); } };
Bun.serve({ port: 3000, fetch: app("one"), websocket });
Bun.serve({ port: 3001, fetch: app("two"), websocket });
console.log("servers-listening");
`;

/**
 * What the playground's Run button starts for the dock test. Its page carries two policies, as an
 * app behind a proxy does: the proxy's same-origin policy with a nonce of its own, and the app's
 * nonce-only policy. `/plain` is no HTML at all, `/locked` allows no script whatever, `/moved`
 * redirects to `/plain`, and `/hang` never answers: documents that say differently, or not at
 * all, that they loaded. `/log` lists the paths the server was asked for.
 */
const DOCK_APP = `
const probe = ${JSON.stringify(PROBE)};
const asked: string[] = [];
Bun.serve({ port: 3000, fetch(req: Request) {
  const path = new URL(req.url).pathname;
  if (path === "/log") return Response.json(asked);
  asked.push(path);
  if (path === "/probe.js") return new Response(probe, { headers: { "content-type": "text/javascript" } });
  if (path === "/hang") return new Promise<Response>(() => {});
  if (path === "/moved") return new Response(null, { status: 302, headers: { location: "/plain?moved" } });
  if (path === "/detour") return new Response(null, { status: 302, headers: { location: "/hang?detour" } });
  if (path === "/sandboxed") return new Response("<!doctype html><title>sandboxed</title><h1>sandboxed</h1>", { headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts" } });
  if (path === "/plain") return new Response("plain text, no markup", { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (path === "/locked") return new Response("<!doctype html><title>locked</title><h1>locked</h1>", { headers: { "content-type": "text/html", "content-security-policy": "script-src 'none'" } });
  const headers = new Headers({ "content-type": "text/html", "set-cookie": "theme=dock; Path=/" });
  headers.append("content-security-policy", "script-src 'self' 'nonce-pr0xy' 'unsafe-eval'");
  headers.append("content-security-policy", "script-src 'nonce-n0nce' 'unsafe-eval'");
  return new Response('<!doctype html><title>dock</title><script nonce="n0nce" src="/probe.js"></script><h1 id="path">dock:' + path + '</h1>', { headers });
} });
console.log("dock-app-listening");
`;

/**
 * A page whose policy names its own host as an http source on port 80. Over https on the default
 * port, browsers upgrade both the scheme and the port of such a source.
 */
const UPGRADE_APP = `
const probe = ${JSON.stringify(PROBE)};
Bun.serve({ port: 3000, fetch(req: Request) {
  const url = new URL(req.url);
  if (url.pathname === "/probe.js") return new Response(probe, { headers: { "content-type": "text/javascript" } });
  const policy = "script-src http://" + (req.headers.get("host") ?? "").replace(/:\\d+$/, "") + ":80 'unsafe-eval'";
  return new Response('<!doctype html><title>upgrade</title><script src="/probe.js"></script><p id="policy">' + policy + '</p>', {
    headers: { "content-type": "text/html", "content-security-policy": policy, "set-cookie": "theme=upgrade; Path=/" },
  });
} });
console.log("upgrade-app-listening");
`;

/** A server that takes every connection and hangs up without a word: the preview frame gets the service worker's error page. */
const DOCK_REFUSER = `
Bun.listen({ hostname: "localhost", port: 3000, socket: { open(socket: { end(): void }) { socket.end(); }, data() {} } });
console.log("dock-refuser-listening");
`;

interface PlaygroundApi {
  editor?: { path?: string; open(path: string): Promise<void> };
  fs: { writeFile(path: string, data: string): Promise<void>; flush(): Promise<void> };
  shell: { submit(command: string): Promise<void> };
  previews?: {
    serves(port: number): boolean;
    linkUrl(port: number): string;
    watchFrame(frame: HTMLIFrameElement, watch: { loaded(href: string | null): void; failed(transient: boolean): void }): () => void;
  };
}

async function playgroundReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const playground = Reflect.get(globalThis, "playground") as unknown as PlaygroundApi | undefined;
    return playground?.editor?.path === "/home/user/index.ts" && document.querySelector("#status")?.getAttribute("data-kind") === "ok";
  }, null, { timeout: 120_000 });
}

/** Opens a file of the examples workspace and presses Run, as a visitor does. */
async function runInPlayground(page: Page, path: string): Promise<void> {
  await page.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run" && !document.querySelector<HTMLButtonElement>("#run")?.disabled, null, { timeout: 60_000 });
  await page.evaluate(file => (Reflect.get(globalThis, "playground") as unknown as PlaygroundApi).editor?.open(file), path);
  await page.locator("#run").click();
}

/** Presses Stop until the foreground program is gone: the second press forces it, as the button's title says. */
async function stopInPlayground(page: Page): Promise<void> {
  const stopped = (timeout: number) => page.waitForFunction(() => document.querySelector("#run")?.getAttribute("data-state") === "run", null, { timeout });
  await page.locator("#run").click();
  await stopped(10_000).catch(async () => {
    await page.locator("#run").click();
    await stopped(60_000);
  });
}

interface Settled {
  /** How the frame sent to the URL settled. */
  outcome: string;
  /** What the watch of a frame that never got an address reported: its initial blank document says nothing. */
  blank: string[];
  /** What the watch of a frame at `/hang` reported: another frame's response is not its own. */
  waiting: string[];
}

/**
 * How a fresh frame at `url` settles, by the IDE page's own watch (RootPreviews.watchFrame). The
 * frame is watched and inserted before it gets its address, as the sandbox's frame is, so its
 * initial blank document loads under the watch. Two more frames are watched beside it.
 */
function frameSettles(page: Page, url: string, hang: string | null = "/hang"): Promise<Settled> {
  return page.evaluate(([target, never]) => new Promise<Settled>((resolve) => {
    const api = (Reflect.get(globalThis, "playground") ?? Reflect.get(globalThis, "sandbox")) as unknown as PlaygroundApi | undefined;
    const previews = api?.previews;
    if (!previews) throw new Error("No previews");
    const watched = (settled: (outcome: string) => void) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.display = "none";
      const stop = previews.watchFrame(frame, { loaded: href => settled(`loaded ${href}`), failed: transient => settled(`failed ${transient}`) });
      document.body.appendChild(frame);
      return { frame, stop };
    };
    const blank: string[] = [];
    const waiting: string[] = [];
    const idle = watched(outcome => blank.push(outcome));
    const hanging = watched(outcome => waiting.push(outcome));
    const shown = watched((outcome) => {
      for (const item of [idle, hanging, shown]) {
        item.stop();
        item.frame.remove();
      }
      resolve({ outcome, blank, waiting });
    });
    if (never !== null) hanging.frame.src = new URL(never, target).href;
    shown.frame.src = target;
  }), [url, hang] as const);
}

/**
 * Sends one watched frame of the page to `url`. The first call makes the frame and returns at once;
 * a later call sends the same frame on, resolves with what its watch reports first, and removes it.
 */
function watchedFrame(page: Page, url: string): Promise<string[]> {
  return page.evaluate(target => new Promise<string[]>((resolve) => {
    interface Kept { frame: HTMLIFrameElement; events: string[]; settled?: () => void; stop(): void }
    const kept = Reflect.get(globalThis, "__watchedFrame") as Kept | undefined;
    if (kept) {
      kept.settled = () => {
        kept.stop();
        kept.frame.remove();
        Reflect.deleteProperty(globalThis, "__watchedFrame");
        resolve(kept.events);
      };
      kept.frame.src = target;
      return;
    }
    const previews = (Reflect.get(globalThis, "playground") as unknown as PlaygroundApi).previews;
    if (!previews) throw new Error("No previews");
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.display = "none";
    const made: Kept = { frame, events: [], stop: () => {} };
    const report = (outcome: string) => {
      made.events.push(outcome);
      made.settled?.();
    };
    made.stop = previews.watchFrame(frame, { loaded: href => report(`loaded ${href}`), failed: transient => report(`failed ${transient}`) });
    Reflect.set(globalThis, "__watchedFrame", made);
    document.body.appendChild(frame);
    frame.src = target;
    resolve([]);
  }), url);
}

/** The paths the dock fixture's server was asked for, read through its page in the dock. */
function dockRequests(page: Page): Promise<string[]> {
  return inPreview(page, async () => (await (await fetch("/log")).json()) as string[], "no request log");
}

/** Starts the two fixture servers in the playground and returns their new-tab links, by port. */
async function startPlaygroundServers(page: Page): Promise<Map<number, URL>> {
  await playgroundReady(page);
  await page.evaluate(async (source) => {
    const playground = Reflect.get(globalThis, "playground") as unknown as PlaygroundApi;
    await playground.fs.writeFile("/home/user/preview-origins-server.ts", source);
    await playground.fs.flush();
    void playground.shell.submit("bun run /home/user/preview-origins-server.ts");
  }, SERVER);
  // The terminal names each server `localhost:<port>`; its link targets what `linkUrl` returns.
  const links = await page.waitForFunction(() => {
    const previews = (Reflect.get(globalThis, "playground") as unknown as PlaygroundApi | undefined)?.previews;
    return previews?.serves(3000) && previews.serves(3001) ? [3000, 3001].map(port => previews.linkUrl(port)) : null;
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

/**
 * A real mouse click on an element of the preview in `page` (a wrapper tab, whose one frame fills it),
 * and the tab the browser opens for it. The click carries user activation, as a visitor's does.
 */
async function clickForNewTab(context: BrowserContext, page: Page, selector: string): Promise<Page> {
  await page.bringToFront();
  const frame = await page.locator("iframe:not([aria-hidden])").boundingBox();
  const inside = await inPreview(page, (query: string) => {
    const box = document.querySelector(query)?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }, `${selector} is not in the preview`, { argument: selector, accept: point => point !== null });
  if (!frame || !inside) throw new Error(`Cannot place a click on ${selector}`);
  const [opened] = await Promise.all([context.waitForEvent("page", { timeout: 60_000 }), page.mouse.click(frame.x + inside.x, frame.y + inside.y)]);
  return opened;
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
      // A document without the shim (Vite serves the stylesheet as text/css) in the tab that does not run
      // the server: the follower hears the owner's answer to its frame's navigation and settles by that.
      expect(await frameSettles(follower, `${src.origin}/src/App.css`, null)).toEqual({ outcome: "loaded null", blank: [], waiting: [] });
      expect(await frameSettles(owner, `${src.origin}/src/App.css`, null)).toEqual({ outcome: "loaded null", blank: [], waiting: [] });
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

      // The app's own new tabs: a real click on its `target="_blank"` link, and on a button that calls
      // window.open, each opens the IDE's wrapper page for that URL, and the server gets the request.
      // The third opens a window with an empty target and a size, which is a new tab like the others.
      for (const [selector, from] of [["#blank", "link"], ["#open", "open"], ["#window", "window"]] as const) {
        const opened = await clickForNewTab(context, tab, selector);
        trackErrors(opened, `opened by ${selector}`, errors);
        await opened.waitForURL(url => url.origin === one.origin && url.pathname === one.pathname && url.searchParams.get("url") === `${origin}/report?from=${from}`, { timeout: 60_000 });
        await text(opened, "#path", "path:/report");
        expect(sorted((await requestEcho(opened)).cookie)).toEqual(["client=1", "sid=secret-one", "theme=dark-one"]);
        // The wrapper page is the IDE's: it keeps no way back to the preview that opened it.
        expect(await opened.evaluate(() => window.opener === null)).toBe(true);
        await opened.close();
      }
      // The link itself is as the app wrote it again.
      expect(await inPreview(tab, () => document.querySelector("#blank")?.getAttribute("href"), "no link")).toBe("/report?from=link");
      const reports = await inPreview(tab, async () => (await (await fetch("/api/log")).json()) as string[], "no log");
      expect(reports.filter(line => line === "one GET /report").length).toBe(3);

      // A tab on the preview origin itself is outside the IDE. The IDE tab is attached and, in this
      // same-site layout, the origin's service worker also controls that tab in Chromium and Firefox;
      // it refuses the visit as the static host does (WebKit's tab gets no worker), and the server,
      // with its cookies, never hears of it.
      const direct = await context.newPage();
      const visit = await navigateTestPage(direct, `${origin}/direct-visit?probe=1`);
      await direct.waitForFunction(() => (document.body?.innerText ?? "").includes("only works inside its IDE tab"), null, { timeout: 60_000 });
      expect(visit?.status()).toBe(403);
      if (browserName === "chromium") expect(visit?.fromServiceWorker()).toBe(true);
      expect(await direct.evaluate(() => document.cookie)).toBe("");
      await direct.close();
      const reached = await inPreview(tab, async () => (await (await fetch("/api/log")).json()) as string[], "no log");
      expect(reached.filter(line => line.includes("direct-visit"))).toEqual([]);

      // Nothing reached the IDE origin, or the browser's own cookie store at all.
      expect(await ide.evaluate(() => document.cookie)).toBe("");
      expect((await context.cookies()).filter(cookie => /^(?:sid|theme|client)$/.test(cookie.name))).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  test(`${browserName}: the playground's docked preview settles by what its frame says, and opens through the IDE's wrapper page`, async () => {
    await withSite(browserName, "same", async (context, served) => {
      const errors: string[] = [];
      const ide = await context.newPage();
      trackErrors(ide, "playground", errors);
      await navigateTestPage(ide, ideUrl("same", served, "/"));
      await playgroundReady(ide);
      await ide.evaluate(async (files) => {
        const playground = Reflect.get(globalThis, "playground") as unknown as PlaygroundApi;
        for (const [name, source] of Object.entries(files)) await playground.fs.writeFile(`/home/user/${name}`, source);
        await playground.fs.flush();
      }, { "dock-app.ts": DOCK_APP, "dock-refuser.ts": DOCK_REFUSER });

      await runInPlayground(ide, "/home/user/dock-app.ts");
      await ide.locator('.preview-dock[data-frame="loaded"]').waitFor({ timeout: 120_000 });
      const src = new URL((await ide.locator(".preview-dock iframe").getAttribute("src")) ?? "about:blank");
      expect(PREVIEW_HOST.exec(src.hostname)?.[1]).toBe("3000");
      // The page carries a proxy's policy and the app's nonce-only one. The shim's tag carries the one nonce
      // that passes both, so the page has its cookies and reported its load.
      expect(await inPreview(ide, () => document.cookie, "no cookie string")).toBe("theme=dock");

      // The open button leads to the IDE's wrapper page, never to a tab on the preview origin itself.
      const link = new URL((await ide.locator(".preview-dock a.control").getAttribute("href")) ?? "about:blank");
      expect(link.origin).toBe(new URL(ide.url()).origin);
      expect(link.pathname.endsWith("/preview-frame.html")).toBe(true);
      expect(link.searchParams.get("url")).toBe(src.href);
      const tab = await openLink(context, link, errors, "dock link");
      await text(tab, "#path", "dock:/");
      await tab.close();

      // Documents that cannot report settle too: plain text, a page whose policy keeps every script out, and
      // plain text behind a redirect. Each settles by its own server response: the server was asked for it,
      // the frame's initial blank document settled nothing, and neither did a frame still waiting for its own.
      // The last has an opaque origin (a `sandbox` policy), which no page of the preview origin can read:
      // it settles because the server answered that frame's navigation.
      for (const [path, served] of [["/plain", "/plain"], ["/locked", "/locked"], ["/moved", "/plain"], ["/sandboxed", "/sandboxed"]] as const) {
        const before = (await dockRequests(ide)).length;
        expect(await frameSettles(ide, `${src.origin}${path}`)).toEqual({ outcome: "loaded null", blank: [], waiting: [] });
        const asked = (await dockRequests(ide)).slice(before);
        expect(asked).toContain(path);
        expect(asked).toContain(served);
      }
      // A frame sent elsewhere while a redirect of its first address is still unanswered settles on the new document.
      const detoured = (await dockRequests(ide)).length;
      await watchedFrame(ide, `${src.origin}/detour`);
      const followed = Date.now() + 60_000;
      while (!(await dockRequests(ide)).slice(detoured).includes("/hang")) {
        if (Date.now() > followed) throw new Error("The redirect to /hang was never followed");
        await ide.waitForTimeout(100);
      }
      expect(await watchedFrame(ide, `${src.origin}/plain`)).toEqual(["loaded null"]);
      expect((await dockRequests(ide)).slice(detoured)).toEqual(["/detour", "/hang", "/plain"]);

      // A frame's load event is no proof: it fires for the service worker's error page as well. A
      // server that answers nothing leaves the dock saying so, after its retries.
      await stopInPlayground(ide);
      await ide.locator(".preview-dock").waitFor({ state: "detached", timeout: 60_000 });
      await runInPlayground(ide, "/home/user/dock-refuser.ts");
      await ide.locator('.preview-dock[data-frame="failed"]').waitFor({ timeout: 120_000 });
      expect(await ide.locator(".preview-dock .spinner").count()).toBe(0);
      expect(await ide.locator(".preview-dock .preview-failed").count()).toBe(1);
      expect(errors).toEqual([]);
    });
  });

  test(`${browserName}: previews work from another site, where a tab on the preview origin itself cannot reach the IDE`, async () => {
    await withSite(browserName, "cross", async (context, served) => {
      const errors: string[] = [];
      const page = await context.newPage();
      trackErrors(page, "sandbox", errors);
      await navigateTestPage(page, ideUrl("cross", served, "/sandbox/", "template=vanilla"));
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
      await navigateTestPage(page, ideUrl("public", served, "/sandbox/", "template=vanilla"));
      await waitForSandboxReady(page);
      const src = await sandboxFrameSrc(page);
      expect(src.hostname.endsWith(`-5173-pv.${PUBLIC_DOMAIN}`)).toBe(true);
      expect(`${src.protocol}//${src.port}`).toBe("https://");
      // Vite answers 403 "Blocked request" to a Host name it does not know. It knows this one.
      await installProbe(page);
      await expectHotReload(page, `preview-origin-public-${Date.now()}`);
      expect(errors).toEqual([]);
    });
  });

  test("chromium: the page script runs under an http source that the browser upgrades to the page's https origin", async () => {
    await withSite("chromium", "public", async (context, served) => {
      const errors: string[] = [];
      const ide = await context.newPage();
      trackErrors(ide, "playground", errors);
      await navigateTestPage(ide, ideUrl("public", served, "/"));
      await playgroundReady(ide);
      await ide.evaluate(async (source) => {
        const playground = Reflect.get(globalThis, "playground") as unknown as PlaygroundApi;
        await playground.fs.writeFile("/home/user/upgrade-app.ts", source);
        await playground.fs.flush();
      }, UPGRADE_APP);
      await runInPlayground(ide, "/home/user/upgrade-app.ts");
      await ide.locator('.preview-dock[data-frame="loaded"]').waitFor({ timeout: 120_000 });
      const src = new URL((await ide.locator(".preview-dock iframe").getAttribute("src")) ?? "about:blank");
      expect(src.origin).toBe(`https://${src.hostname}`);
      // The page's only script source is `http://<its host>:80`. The browser runs the app's own https
      // script under it (the probe answers), so the page script must be there too: the cookie the
      // server set is readable only through it.
      expect(await inPreview(ide, () => document.querySelector("#policy")?.textContent, "no policy")).toBe(`script-src http://${src.hostname}:80 'unsafe-eval'`);
      expect(await inPreview(ide, () => document.cookie, "no cookie string")).toBe("theme=upgrade");
      expect(errors).toEqual([]);
    });
  });
}
