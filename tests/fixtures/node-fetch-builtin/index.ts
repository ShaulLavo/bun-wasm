// Bun serves node-fetch, undici, isomorphic-fetch and @vercel/fetch from its own
// builtins, even when node_modules has the npm package (here, stand-ins that
// would print if loaded).
import vercelFetch from "@vercel/fetch";
import isoFetch from "isomorphic-fetch";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import * as undici from "undici";

// node-fetch keeps the original web classes even when the globals were replaced before its first load.
const require = createRequire(import.meta.url);
const globals = globalThis as Record<string, unknown>;
const originals = { Response: globals.Response, Request: globals.Request, Headers: globals.Headers, fetch: globals.fetch };
Object.assign(globals, { Response: class BadResponse {}, Request: class BadRequest {}, Headers: class BadHeaders {}, fetch() {} });
const nodeFetch = require("node-fetch");
Object.assign(globals, originals);
const { fetch, Headers, Request, Response } = nodeFetch;

const { default: imported } = await import("node-fetch");
console.log("same module:", imported === nodeFetch, require("undici").fetch === undici.fetch);
console.log("resolve:", require.resolve("node-fetch"), require.resolve("undici"));
console.log("exports:", typeof nodeFetch, nodeFetch.default === nodeFetch, nodeFetch.fetch === fetch, nodeFetch.Response === Response);
console.log("subclasses:", Response.prototype instanceof globalThis.Response, Request.prototype instanceof globalThis.Request, Headers.prototype instanceof globalThis.Headers);

const headers = new Headers({ a: "1" });
headers.append("Set-Cookie", "b=1");
headers.append("Set-Cookie", "c=1");
// Key order is not part of this check: Bun lists well-known header names first.
const raw = headers.raw();
console.log("raw:", JSON.stringify(Object.keys(raw).sort().map(key => [key, raw[key]])));
console.log("relative request url:", new Request("/path").url);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/204") return new Response(null, { status: 204 });
    if (url.pathname === "/json") return Response.json({ ok: true });
    if (url.pathname === "/echo") return new Response(`${req.method} ${req.headers.get("content-type")} ${await req.text()}`);
    return new Response("hello world", { headers: { "x-test": "yes" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;

async function readAll(body: AsyncIterable<Uint8Array | string>) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

const posted = await nodeFetch(`${base}/echo`, { method: "POST", body: Readable.from(["the input ", "text"]) });
console.log("node stream body:", posted.body instanceof Readable, posted.body === posted.body, await readAll(posted.body));

const empty = await fetch(`${base}/204`);
console.log("204 body:", empty.status, empty.body instanceof Readable, JSON.stringify(await readAll(empty.body)));
console.log("constructed null body:", new Response(null).body);

const plain = await fetch(base);
console.log("headers:", plain.headers.raw()["x-test"], plain.type);
console.log("buffer:", Buffer.isBuffer(await plain.clone().buffer()), await plain.text());
console.log("json:", JSON.stringify(await (await fetch(`${base}/json`)).json()));

const requested = await undici.request(`${base}/echo`, { method: "PUT", body: Buffer.from("via undici") });
console.log("undici.request:", requested.statusCode, requested.body instanceof Readable, await requested.body.text());
const undiciResponse = await undici.fetch(base);
console.log("undici.fetch:", undiciResponse instanceof globalThis.Response, await undiciResponse.text());

console.log("isomorphic-fetch:", isoFetch.fetch === isoFetch, await (await isoFetch(base)).text());
const vercel = await vercelFetch(fetch)(`${base}/echo`, { method: "POST", body: { a: 1 } });
console.log("@vercel/fetch:", await vercel.text());

server.stop(true);
