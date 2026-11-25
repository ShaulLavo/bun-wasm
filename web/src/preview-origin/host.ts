// The static host of preview origins, for a Cloudflare Worker, Bun.serve or any fetch handler.
// It serves four fixed files and nothing else: once an origin's service worker is installed, no
// request of the app reaches this host again.
import { parsePreviewHost, RELAY_PATH, SW_PATH } from "./protocol";

export type PreviewOriginAsset = "sw.js" | "relay.html" | "bootstrap.html" | "top.html";

export interface PreviewOriginHostConfig {
  /** The domain preview hosts end with, as in the IDE page's configuration. */
  domain: string;
  /** The IDE origins that may frame a preview and attach to its service worker. */
  ideOrigins: readonly string[];
  /** The built file of that name (web/preview-origin-build.ts). */
  asset(name: PreviewOriginAsset): Promise<string> | string;
}

/** Marks where the allowed IDE origins go in relay.html. */
export const IDE_ORIGINS_PLACEHOLDER = '"__BUNWASM_PREVIEW_IDE_ORIGINS__"';

function headers(config: PreviewOriginHostConfig, contentType: string): Headers {
  const result = new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    // The IDE page is cross-origin isolated: its frames must opt in or the browser refuses them.
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "cross-origin",
  });
  if (contentType.startsWith("text/html")) result.set("content-security-policy", `frame-ancestors ${config.ideOrigins.join(" ") || "'none'"}`);
  return result;
}

function originsLiteral(config: PreviewOriginHostConfig): string {
  return JSON.stringify(config.ideOrigins).replaceAll("<", "\\u003c");
}

async function page(config: PreviewOriginHostConfig, name: PreviewOriginAsset, head: boolean): Promise<Response> {
  const text = (await config.asset(name)).replace(IDE_ORIGINS_PLACEHOLDER, () => originsLiteral(config));
  return new Response(head ? null : text, { headers: headers(config, "text/html; charset=utf-8") });
}

async function worker(config: PreviewOriginHostConfig, head: boolean): Promise<Response> {
  const result = headers(config, "text/javascript; charset=utf-8");
  result.set("service-worker-allowed", "/");
  const script = `self.__bunwasmPreviewIdeOrigins=${originsLiteral(config)};\n${await config.asset("sw.js")}`;
  return new Response(head ? null : script, { headers: result });
}

function isNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  return request.headers.get("accept")?.includes("text/html") ?? false;
}

/**
 * Answers a request for a preview host, or returns null when the request is for another host.
 * A host that matches the preview name shape never falls through to the caller's own files.
 */
export function handlePreviewOriginRequest(request: Request, config: PreviewOriginHostConfig): Promise<Response> | null {
  const url = new URL(request.url);
  if (!parsePreviewHost(url.host, config.domain)) return null;
  const head = request.method === "HEAD";
  const refused = (status: number, message: string) => Promise.resolve(new Response(head ? null : `${message}\n`, { status, headers: headers(config, "text/plain; charset=utf-8") }));
  if (request.method !== "GET" && !head) return refused(503, "This preview's service worker is not running yet. Reload the preview.");
  if (url.pathname === SW_PATH) return worker(config, head);
  if (url.pathname === RELAY_PATH) return page(config, "relay.html", head);
  if (!isNavigation(request)) return refused(503, "This preview's service worker is not running yet. Reload the preview.");
  // A top-level tab on the preview origin cannot reach the IDE tab in every browser.
  return page(config, request.headers.get("sec-fetch-dest") === "document" ? "top.html" : "bootstrap.html", head);
}
