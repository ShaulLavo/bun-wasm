import { acceptedEncodings, type Encoding } from "../scripts/accept-encoding";

function negotiationHeaders(metadata: Headers): Headers {
  const headers = new Headers(metadata);
  const vary = headers.get("vary");
  if (!vary?.split(",").some(value => ["*", "accept-encoding"].includes(value.trim().toLowerCase())))
    headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  return headers;
}

function represented(response: Response, metadata: Headers, encoding: Encoding): Response {
  const headers = negotiationHeaders(metadata);
  const cache = headers.get("cache-control");
  if (encoding !== "identity" && !cache?.split(",").some(value => value.trim().toLowerCase() === "no-transform"))
    headers.set("cache-control", cache ? `${cache}, no-transform` : "no-transform");
  for (const field of ["content-length", "etag", "last-modified", "content-range", "accept-ranges"]) {
    const value = response.headers.get(field);
    if (value === null) headers.delete(field);
    else headers.set(field, value);
  }
  headers.set("content-type", "application/wasm");
  if (encoding === "identity") headers.delete("content-encoding");
  else headers.set("content-encoding", encoding);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, encodeBody: encoding === "identity" ? "automatic" : "manual" });
}

function negotiationError(status: number, metadata: Headers): Response {
  const headers = negotiationHeaders(metadata);
  for (const field of ["content-length", "content-encoding", "etag", "last-modified", "content-range", "accept-ranges"]) headers.delete(field);
  return new Response(null, { status, headers });
}

/**
 * The logical URL's metadata: the raw file's when it ships, else its first twin's. Programs ship raw
 * beside `.br` and `.gz` twins; Bun guests ship only the twins (jsc-engine.wasm is 34 MB raw, over
 * the 25 MiB asset limit). Undefined when no representation exists.
 */
async function logicalMetadata(env: SiteEnv, url: URL, headers: Headers): Promise<Response | undefined> {
  const metadataHeaders = new Headers(headers);
  for (const field of ["range", "if-range", "if-none-match", "if-modified-since", "if-match", "if-unmodified-since"]) metadataHeaders.delete(field);
  for (const suffix of ["", ".br", ".gz"]) {
    const target = new URL(url);
    target.pathname += suffix;
    const response = await env.ASSETS.fetch(new Request(target, { method: "HEAD", headers: metadataHeaders }));
    if (response.status === 200) return response;
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
    // Every program and Bun guest WASM may ship `.br` and `.gz` twins (wrangler.jsonc routes them here).
    if (!url.pathname.endsWith(".wasm") || !["GET", "HEAD"].includes(request.method)) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    headers.set("accept-encoding", "identity");
    const metadata = await logicalMetadata(env, url, headers);
    if (!metadata) return env.ASSETS.fetch(request);
    const originalEncoding = request.cf?.clientAcceptEncoding;
    const preference = acceptedEncodings(typeof originalEncoding === "string" ? originalEncoding : request.headers.get("accept-encoding"));
    if (!preference) return negotiationError(400, metadata.headers);
    for (const encoding of preference) {
      const selected = new URL(url);
      if (encoding !== "identity") selected.pathname += encoding === "br" ? ".br" : ".gz";
      const response = await env.ASSETS.fetch(new Request(selected, { method: request.method, headers }));
      if ([200, 206, 304].includes(response.status)) return represented(response, metadata.headers, encoding);
      if (response.status !== 404) return response;
      await response.body?.cancel();
    }
    return negotiationError(406, metadata.headers);
  },
} satisfies ExportedHandler<SiteEnv>;
