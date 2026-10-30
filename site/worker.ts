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

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
    const program = url.pathname.startsWith("/programs/base/") || url.pathname.startsWith("/playground/programs/base/");
    if (!program || !url.pathname.endsWith(".wasm") || !["GET", "HEAD"].includes(request.method)) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    headers.set("accept-encoding", "identity");
    const metadataHeaders = new Headers(headers);
    for (const field of ["range", "if-range", "if-none-match", "if-modified-since", "if-match", "if-unmodified-since"]) metadataHeaders.delete(field);
    const metadata = await env.ASSETS.fetch(new Request(request, { method: "HEAD", headers: metadataHeaders }));
    // Waffle's package closure includes the canonical raw program beside its optional sidecars.
    if (metadata.status !== 200) return env.ASSETS.fetch(request);
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
