// Entry of the preview-origin service worker: one registration, scope `/`, per preview origin
// (`<id>-<port>-pv.<domain>`). Every request of the app is relayed to the IDE page; see sw-core.ts.
import { createPreviewOriginServiceWorker } from "./sw-core";

const sw = self as unknown as ServiceWorkerGlobalScope;
declare const __PREVIEW_ORIGIN_SHIM__: string;

/** The static host prepends `self.__bunwasmPreviewIdeOrigins=[...]` to this script. */
function ideOrigins(): string[] {
  const value: unknown = Reflect.get(sw, "__bunwasmPreviewIdeOrigins");
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const worker = createPreviewOriginServiceWorker({
  origin: sw.location.origin,
  clients: {
    get: id => sw.clients.get(id),
    matchAll: () => sw.clients.matchAll({ type: "window", includeUncontrolled: true }),
  },
  shimScript: __PREVIEW_ORIGIN_SHIM__,
  ideOrigins: ideOrigins(),
  userAgent: sw.navigator.userAgent,
});

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", event => event.waitUntil(sw.clients.claim()));
sw.addEventListener("fetch", event => {
  const response = worker.fetch(event.request, event.clientId);
  if (response) event.respondWith(response);
});
sw.addEventListener("message", event => {
  const source = event.source && "url" in event.source ? { id: event.source.id, url: event.source.url } : null;
  worker.message({ data: event.data, ports: event.ports, source });
});
