// Live-site mode for the visible iPhone observer. The observer must inject its script into the
// pages Safari loads, and a deployed site cannot carry it. The Mac observer therefore serves the
// deployed site on loopback. Each request goes to the live origin with Safari's own headers (less
// Host, Origin, Referer and hop-by-hop fields), and the response reaches Safari with its status,
// headers, content encoding and bytes unchanged, except that same-site redirects stay on loopback.
// The only exceptions are the two responses the observer rewrites: HTML navigations and service
// worker scripts. For those the proxy asks the live origin for identity encoding, and the observer
// adds its script and replaces their cache-control, etag, last-modified and content-length.
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** The deployed playground, relative to the site root. */
export const livePlaygroundPath = "playground/";

export function liveSiteURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`--base-url is not a URL: ${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--base-url must be an https site root such as https://bun.shaulavo.dev/, without path, query or credentials");
  return url.href;
}

/** What the live origin sent the proxy for one request, so the PC can repeat it against the real origin. */
export interface LiveServed {
  url: string;
  request: Record<string, string>;
  status: number;
  headers: Record<string, string>;
  sha256: string | null;
}
/** Response headers whose value must match between the proxied run and the real origin. */
export const comparedHeaders = ["content-type", "content-encoding", "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy", "cache-control", "service-worker-allowed"];
const replayed = ["accept", "accept-encoding", "accept-language", "user-agent", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"];
const requestOnly = ["host", "connection", "keep-alive", "origin", "referer", "content-length", "transfer-encoding"];
const hopByHop = ["transfer-encoding", "connection", "keep-alive"];

/** HTML navigations and service workers are the only responses the observer rewrites. */
function rewrittenByObserver(request: Request): boolean {
  return request.mode === "navigate" || request.headers.get("sec-fetch-mode") === "navigate" || new URL(request.url).pathname.endsWith("/sw.js");
}

export function pick(headers: Headers, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap(name => { const value = headers.get(name); return value === null ? [] : [[name, value]]; }));
}

export async function proxyLiveRequest(request: Request, site: string, upstream: typeof fetch = fetch, record?: (row: LiveServed) => void): Promise<Response> {
  const incoming = new URL(request.url), origin = new URL(liveSiteURL(site)).origin;
  const target = new URL(incoming.pathname + incoming.search, origin);
  const headers = new Headers(request.headers);
  for (const name of requestOnly) headers.delete(name);
  if (rewrittenByObserver(request)) headers.set("accept-encoding", "identity");
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const response = await upstream(target, { method: request.method, headers, body, redirect: "manual", decompress: false });
  const replies = new Headers(response.headers);
  for (const name of hopByHop) replies.delete(name);
  const location = replies.get("location");
  if (location) replies.set("location", loopbackLocation(location, target, origin, incoming.origin));
  let delivered = request.method === "HEAD" ? null : response.body;
  const platformRoute = incoming.pathname.startsWith("/cdn-cgi/");
  const previewRoute = incoming.pathname.includes("/__preview/");
  const full = !platformRoute && !(previewRoute && response.status >= 400) && delivered !== null && fullResponse(request, headers, response);
  const recordableError = response.status >= 400
    && (request.method === "GET" || request.method === "HEAD")
    && !previewRoute
    && !platformRoute;
  if (record && (full || recordableError)) {
    const row = { url: incoming.pathname + incoming.search, request: pick(headers, replayed), status: response.status, headers: pick(response.headers, comparedHeaders) };
    if (full && delivered) {
      const [safari, copy] = delivered.tee();
      delivered = safari;
      void new Response(copy).bytes().then(bytes => record({ ...row, sha256: decodedSha256(bytes, response.headers.get("content-encoding")) }), () => record({ ...row, sha256: null }));
    } else {
      record({ ...row, sha256: null });
    }
  }
  return new Response(delivered, { status: response.status, statusText: response.statusText, headers: replies });
}

/** Only an unconditional, whole GET can be repeated and compared byte for byte. */
function fullResponse(request: Request, headers: Headers, response: Response): boolean {
  if (request.method !== "GET" || response.status === 206 || response.status === 304) return false;
  return !["range", "if-none-match", "if-modified-since", "if-range"].some(name => headers.has(name));
}

function loopbackLocation(location: string, target: URL, origin: string, loopback: string): string {
  const moved = new URL(location, target);
  return moved.origin === origin ? loopback + moved.pathname + moved.search + moved.hash : moved.href;
}

/** The SHA-256 of a body after removing its content encoding. */
export function decodedSha256(bytes: Uint8Array, encoding: string | null): string {
  return new Bun.CryptoHasher("sha256").update(decoded(bytes, encoding?.trim().toLowerCase() ?? "")).digest("hex");
}
function decoded(bytes: Uint8Array, encoding: string): Uint8Array {
  if (encoding === "" || encoding === "identity") return bytes;
  if (encoding === "br") return brotliDecompressSync(bytes);
  if (encoding === "gzip") return gunzipSync(bytes);
  if (encoding === "deflate") return inflateSync(bytes);
  if (encoding === "zstd") return Bun.zstdDecompressSync(bytes);
  throw new Error(`Unsupported content encoding ${encoding}`);
}
