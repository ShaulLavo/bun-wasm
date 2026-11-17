import { LoopbackPreviewOrigins } from "../../web/preview-origin-host";
import { IphoneBus } from "./iphone-bus";
import { observeIphoneServiceWorker } from "./iphone-service-worker";
import { liveSiteURL, proxyLiveRequest } from "./iphone-live-proxy";

export async function observeIphoneResponse(response: Response, request: Request, bus: IphoneBus, endpoint: string): Promise<Response> {
  if (response.status === 200 && new URL(request.url).pathname.endsWith("/sw.js")) {
    const source = `(${observeIphoneServiceWorker.toString()})(${JSON.stringify(endpoint + bus.path)});\n`;
    const headers = new Headers(response.headers);
    headers.delete("content-length"); headers.delete("etag"); headers.set("cache-control", "no-store");
    return new Response(source + await response.text(), { status: response.status, headers });
  }
  if (request.mode !== "navigate" && request.headers.get("sec-fetch-mode") !== "navigate") return response;
  if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return response;
  if (response.headers.has("content-encoding")) throw new Error("iPhone observer requires uncompressed HTML");
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error("iPhone observer HTML exceeds 2 MiB");
  const html = bus.inject(text, request.url, endpoint);
  if (html === text) return new Response(text, response);
  const headers = new Headers(response.headers);
  for (const key of ["content-length", "etag", "last-modified"]) headers.delete(key);
  headers.set("cache-control", "no-store");
  if (!headers.has("cross-origin-embedder-policy")) headers.set("cross-origin-embedder-policy", "require-corp");
  if (!headers.has("cross-origin-resource-policy")) headers.set("cross-origin-resource-policy", "cross-origin");
  return new Response(html, { status: response.status, headers });
}

function previewRequest(request: Request, bus: IphoneBus): Request {
  if (bus.state("preview")?.url !== request.url) return request;
  if (request.mode !== "navigate" && request.headers.get("sec-fetch-mode") !== "navigate") return request;
  const headers = new Headers(request.headers);
  headers.set("accept-encoding", "identity");
  return new Request(request, { headers });
}

export function observeIphoneOrigins(bus: IphoneBus, endpoint: string): () => void {
  const original = LoopbackPreviewOrigins.prototype.bind;
  LoopbackPreviewOrigins.prototype.bind = function (owner, port, target) {
    return original.call(this, owner, port, { ...target,
      fetch: async request => observeIphoneResponse(await target.fetch(previewRequest(request, bus)), request, bus, endpoint),
    });
  };
  return () => { LoopbackPreviewOrigins.prototype.bind = original; };
}

/** Serves the prepared ROOT through the playground's own server, observing every response. */
async function serveLocal(bus: IphoneBus, endpoint: string): Promise<string> {
  let productOrigin = "";
  observeIphoneOrigins(bus, endpoint);
  const serve = Bun.serve;
  Object.defineProperty(Bun, "serve", { value(options: unknown) {
    if (!options || typeof options !== "object" || !("fetch" in options) || typeof options.fetch !== "function") throw new Error("Expected playground server options");
    const fetch = options.fetch;
    const server = Reflect.apply(serve, Bun, [{ ...options, async fetch(request: Request, server: unknown) {
      const response: unknown = await Reflect.apply(fetch, this, [request, server]);
      return response instanceof Response ? observeIphoneResponse(response, request, bus, endpoint) : response;
    } }]);
    productOrigin = String(server.url.origin);
    return server;
  } });
  try { await import("../../web/serve"); }
  finally { Bun.serve = serve; }
  return productOrigin;
}

/** Serves the deployed site at LIVE_URL on loopback, observing every response. Stops on the same signals as the local server. */
function serveLive(site: string, bus: IphoneBus, endpoint: string): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 0), idleTimeout: 0,
    fetch: async request => observeIphoneResponse(await proxyLiveRequest(request, site), request, bus, endpoint),
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void server.stop(true).finally(() => process.exit()); });
  console.log(`proxying ${site} at ${server.url.origin}/`);
  return server.url.origin;
}

if (import.meta.main) {
  const token = process.env.GOALS_IPHONE_TOKEN;
  const live = process.env.LIVE_URL ? liveSiteURL(process.env.LIVE_URL) : undefined;
  if (!token || !/^[a-f0-9]{64}$/.test(token) || process.env.HOST !== "127.0.0.1" || (!live && process.env.PREVIEW_ORIGINS !== "1")) throw new Error("Require loopback host, GOALS_IPHONE_TOKEN, and preview origins or LIVE_URL");
  const bus = new IphoneBus("/__goals_iphone/" + token, row => console.log(JSON.stringify({ iphoneResponse: row })));
  let productOrigin = "";
  const control = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.GOALS_IPHONE_PORT ?? 0), idleTimeout: 0, maxRequestBodySize: 512 * 1024,
    fetch: request => new URL(request.url).pathname.startsWith(bus.path + "/") ? bus.handle(request, productOrigin) : new Response(null, { status: 404 }),
  });
  productOrigin = live ? serveLive(live, bus, control.url.origin) : await serveLocal(bus, control.url.origin);
  console.log(JSON.stringify({ iphoneControl: control.url.origin + bus.path, productOrigin }));
  process.once("SIGTERM", () => { bus.close(); void control.stop(true); });
}
