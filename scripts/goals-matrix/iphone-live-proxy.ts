// Live-site mode for the visible iPhone observer. The observer must inject its script into the
// pages Safari loads, and a deployed site cannot carry it. The Mac observer therefore serves the
// deployed site's own bytes on loopback: every request goes to the live origin unchanged, and only
// the observer injection differs from what a visitor receives. The page runs at a loopback origin.

/** The deployed playground, relative to the site root. */
export const livePlaygroundPath = "playground/";

export function liveSiteURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`--base-url is not a URL: ${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--base-url must be an https site root such as https://bun.sprockt.dev/, without path, query or credentials");
  return url.href;
}

const requestOnly = ["host", "connection", "keep-alive", "accept-encoding", "origin", "referer", "content-length", "transfer-encoding"];
const hopByHop = ["transfer-encoding", "connection", "keep-alive"];
// Fetch decodes upstream content encodings itself, so a decoded body keeps neither encoding nor length.
const decoded = ["content-encoding", "content-length"];

export async function proxyLiveRequest(request: Request, site: string, upstream: typeof fetch = fetch): Promise<Response> {
  const incoming = new URL(request.url), origin = new URL(liveSiteURL(site)).origin;
  const target = new URL(incoming.pathname + incoming.search, origin);
  const headers = new Headers(request.headers);
  for (const name of requestOnly) headers.delete(name);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const response = await upstream(target, { method: request.method, headers, body, redirect: "manual" });
  const replies = new Headers(response.headers);
  const removed = response.headers.has("content-encoding") ? hopByHop.concat(decoded) : hopByHop;
  for (const name of removed) replies.delete(name);
  const location = replies.get("location");
  if (location) replies.set("location", loopbackLocation(location, target, origin, incoming.origin));
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers: replies });
}

function loopbackLocation(location: string, target: URL, origin: string, loopback: string): string {
  const moved = new URL(location, target);
  return moved.origin === origin ? loopback + moved.pathname + moved.search + moved.hash : moved.href;
}
