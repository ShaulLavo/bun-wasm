import { createPreviewServiceWorker } from "waffle/browser/service-worker";
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const previews = createPreviewServiceWorker({ scope: worker.registration.scope, clients: worker.clients, fetch: request => fetch(request) });
worker.addEventListener("install", () => void worker.skipWaiting());
worker.addEventListener("activate", event => event.waitUntil(worker.clients.claim()));
worker.addEventListener("fetch", event => {
  const response = previews.fetch(event.request, event.clientId);
  if (response) event.respondWith(response);
});
