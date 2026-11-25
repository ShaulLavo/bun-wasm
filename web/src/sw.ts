// Service worker for Bun.serve previews and the browser engine's ES modules. The page registers it
// twice, never over itself (its COOP/COEP headers stay untouched):
//
// Scope `<app>/__bunwasm/` controls the bun workers started from `<app>/__bunwasm/worker.js`. Paths
// under it are the app's own files, served with the headers a worker script needs. Guest ES modules
// never come from here: the worker loads them as registration records (module-records.ts).
//
// Scope `<app>/__preview/` controls only preview tabs:
// A request for `<app>/__preview/(r/<route>/)?<port>/<path>` is forwarded strictly to the owning
// window registered for `(routeKey, port)` (see preview.ts & sw-routing.ts).

import { previewNavigations } from "./preview-navigation";
import { createRoutedPreviewServiceWorker } from "./sw-routing";

const sw = self as unknown as ServiceWorkerGlobalScope;
const prefix = new URL(sw.registration.scope).pathname;
declare const __PREVIEW_SOCKET_SCRIPT__: string;
const SOCKET_SCRIPT_PATH = new URL("../preview-websocket.js", sw.registration.scope).pathname;
const MODULES = prefix.endsWith("/__bunwasm/");

const previews = createRoutedPreviewServiceWorker({
  scope: sw.registration.scope,
  clients: sw.clients,
  fetch: request => fetch(request),
  socketScriptPath: SOCKET_SCRIPT_PATH,
});

const navigations = previewNavigations({
  scope: sw.registration.scope,
  clients: sw.clients,
  fetch: (request, clientId, signal) => previews.fetch(request, clientId, signal) ?? fetch(request),
  transientRetryMs: 2000,
});

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", event => event.waitUntil(sw.clients.claim()));
sw.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (MODULES) {
    if (url.pathname.startsWith(prefix)) event.respondWith(moduleScope(event.request, url.pathname.slice(prefix.length)));
    return;
  }
  if (url.pathname === SOCKET_SCRIPT_PATH) {
    event.respondWith(new Response(__PREVIEW_SOCKET_SCRIPT__, { headers: { "content-type": "text/javascript" } }));
    return;
  }
  const response = navigations.fetch(event.request, event.clientId, event.resultingClientId) ?? previews.fetch(event.request, event.clientId);
  if (response) event.respondWith(response);
});

/** The app file of that name. */
async function moduleScope(request: Request, rest: string): Promise<Response> {
  const target = new URL(rest, new URL("..", sw.registration.scope));
  target.search = new URL(request.url).search;
  const upstream = await fetch(target.href);
  const headers = new Headers(upstream.headers);
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  headers.set("cross-origin-embedder-policy", "require-corp");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (!upstream.ok) headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

sw.addEventListener("message", event => {
  if (MODULES) return;
  const source = event.source && "url" in event.source
    ? { id: "id" in event.source ? event.source.id : undefined, url: event.source.url }
    : null;
  const task = previews.message({ data: event.data, ports: event.ports, source });
  if (task) event.waitUntil(task);
});
