// Runs first in every HTML document a preview origin serves (the service worker injects it).
// It gives the page what a service worker cannot: WebSockets to the dev server, cookies, and a
// word to the embedding IDE that the document really committed.
import "../preview-websocket-client";
import { CookieJar } from "./cookie-jar";
import { installNewTabs } from "./new-tab";
import { COOKIE_PATH, FRAME_MESSAGE, loopbackHost, SW_COOKIES, SW_COOKIES_ACK, SW_SHIM, type ScriptCookie } from "./protocol";

const script = document.currentScript;
const container = navigator.serviceWorker;
// Applications may replace fetch; cookie writes must not go through their wrappers.
const nativeFetch = globalThis.fetch.bind(globalThis);

// The bootstrap page counts its reloads; a document served here ends that count.
try { sessionStorage.removeItem("bunwasm-preview-bootstrap"); } catch {}

// ---- cookies ----

function initialCookies(): ScriptCookie[] {
  try {
    const value: unknown = JSON.parse(script?.getAttribute("data-cookies") ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const jar = new CookieJar(location.hostname, location.protocol === "https:" || loopbackHost(location.hostname));
jar.replaceScriptCookies(initialCookies());
let pendingWrites = 0;

/** The IDE's view replaces the mirror, except while local writes it has not confirmed are pending. */
function adopt(cookies: unknown): void {
  if (pendingWrites === 0 && Array.isArray(cookies)) jar.replaceScriptCookies(cookies);
}

/** A write travels as a fetch so the service worker forwards it before any later request. */
function writeCookie(line: string): void {
  if (!jar.setFromScript(line, location.pathname)) return;
  const target = new URL(COOKIE_PATH, location.origin);
  target.searchParams.set("line", line);
  target.searchParams.set("url", location.href);
  pendingWrites++;
  nativeFetch(target, { cache: "no-store" })
    .then(response => response.json())
    .then(cookies => { pendingWrites--; adopt(cookies); }, () => { pendingWrites--; });
}

// The browser's own cookie store stays empty for this origin: the IDE page holds the jar.
Object.defineProperty(Document.prototype, "cookie", {
  configurable: true,
  enumerable: true,
  get: () => jar.scriptString(location.pathname),
  set: (line: unknown) => writeCookie(String(line)),
});

interface StoreCookie { name?: string; value?: string; path?: string; expires?: number | Date | null; sameSite?: string }

function storeLine(cookie: StoreCookie): string {
  const expires = cookie.expires === null || cookie.expires === undefined ? "" : `; Expires=${new Date(cookie.expires).toUTCString()}`;
  const sameSite = cookie.sameSite ? `; SameSite=${cookie.sameSite}` : "";
  return `${cookie.name ?? ""}=${cookie.value ?? ""}; Path=${cookie.path ?? "/"}${expires}${sameSite}`;
}

function installCookieStore(): void {
  const store: unknown = Reflect.get(globalThis, "cookieStore");
  if (!store || typeof store !== "object") return;
  const named = (input: unknown) => (typeof input === "string" ? input : (input as StoreCookie | undefined)?.name);
  const all = (input?: unknown) => jar.scriptCookies().filter(cookie => named(input) === undefined || cookie.name === named(input));
  Object.assign(store, {
    getAll: async (input?: unknown) => all(input),
    get: async (input?: unknown) => all(input)[0] ?? null,
    set: async (input: unknown, value?: string) => writeCookie(storeLine(typeof input === "string" ? { name: input, value } : (input as StoreCookie))),
    delete: async (input: unknown) => writeCookie(storeLine({ ...(typeof input === "string" ? { name: input } : (input as StoreCookie)), value: "", expires: 0 })),
  });
}
installCookieStore();

container?.addEventListener("message", event => {
  const data = event.data as { type?: unknown; cookies?: unknown; ack?: unknown } | null;
  if (data?.type !== SW_COOKIES) return;
  adopt(data.cookies);
  if (typeof data.ack === "number") container.controller?.postMessage({ type: SW_COOKIES_ACK, ack: data.ack });
});
container?.startMessages();
container?.controller?.postMessage({ type: SW_SHIM });

// ---- the preview's own service worker stays in charge ----

if (container) {
  const keep = (action: string) => console.warn(`[preview] ${action} is ignored: this preview's service worker carries every request to the dev server.`);
  Object.defineProperty(ServiceWorkerContainer.prototype, "register", {
    configurable: true,
    writable: true,
    value(this: ServiceWorkerContainer) { keep("navigator.serviceWorker.register()"); return this.ready; },
  });
  Object.defineProperty(ServiceWorkerRegistration.prototype, "unregister", {
    configurable: true,
    writable: true,
    value() { keep("ServiceWorkerRegistration.unregister()"); return Promise.resolve(false); },
  });
}

// ---- new tabs go through the IDE ----

const wrapper = script?.getAttribute("data-wrapper");
if (wrapper) installNewTabs(wrapper);

// ---- tell the embedder ----

function report(event: "commit" | "load"): void {
  if (parent === window) return;
  parent.postMessage({ type: FRAME_MESSAGE, event, href: location.href, title: document.title }, "*");
}

for (const method of ["pushState", "replaceState"] as const) {
  const original = history[method];
  history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
    original.apply(this, args);
    report("commit");
  };
}
addEventListener("popstate", () => report("commit"));
addEventListener("hashchange", () => report("commit"));
addEventListener("load", () => report("load"));
report("commit");
