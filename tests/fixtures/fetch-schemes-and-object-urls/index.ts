import { mkdtempSync } from "node:fs";

// fetch() reads URLs the way Bun's client does: a scheme only before "://" (so host:port is
// http), object URLs answer with their Blob, and other schemes are refused.
const failure = (error: any) => `${error.name} ${error.code} ${JSON.stringify(String(error.message).replace(/blob:[0-9a-f-]{36}/, "blob:<uuid>"))}`;

await using server = Bun.serve({ port: 0, fetch: req => new Response(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("hello")}`) });
const res = await fetch(`localhost:${server.port}/hello`, { headers: { hello: "world" } });
console.log("host:port without a scheme:", res.status, await res.text(), res.url === `localhost:${server.port}/hello`);
const viaRequest = await fetch(new Request(`localhost:${server.port}/request`, { method: "POST", body: "x" }));
console.log("a Request to host:port without a scheme:", viaRequest.status, await viaRequest.text());
console.log("an IP and port without a scheme:", await fetch(`127.0.0.1:${server.port}/a`).then(r => `resolved ${r.status}`, (error: any) => `${error.name} ${error.code} ${error.message}`));

const url = URL.createObjectURL(new Blob(["hi"], { type: "text/x-fixture" }));
const blobRes = await fetch(url, { method: "POST", body: "ignored" });
console.log("object URL:", blobRes.status, JSON.stringify(blobRes.statusText), blobRes.headers.get("content-type"), blobRes.url === url, blobRes.redirected, await blobRes.text());
const upper = await fetch(url.replace("blob:", "BLOB:"));
console.log("object URL with an upper-case scheme:", upper.status, upper.url === url, await upper.text());
URL.revokeObjectURL(url);
for (const [label, target] of [
  ["revoked object URL", url],
  ["unregistered object URL", "blob:00000000-0000-0000-0000-000000000000"],
  ["a scheme in front of a scheme", "blob:http://example.com/id"],
  ["view-source:", "view-source:http://example.com/"],
  ["unsupported protocol", "gopher://example.com/"],
] as const) {
  console.log(label, await fetch(target).then(r => `resolved ${r.status}`, failure));
}

// The rejection reaches process.on("unhandledRejection") as is.
const delivered = Promise.withResolvers<string>();
process.once("unhandledRejection", (reason: any, promise) => delivered.resolve(`${promise === returned} ${reason.code} ${reason.message}`));
const returned = fetch("gopher://example.com/");
console.log("unhandled rejection:", await delivered.promise);

const session = new Bun.FetchSession();
console.log("FetchSession:", Object.prototype.toString.call(session), typeof session.fetch, typeof session.close);
console.log("session fetch:", await session.fetch(`http://localhost:${server.port}/session`).then(r => r.text()), await session.fetch("ftp://127.0.0.1:1/").then(() => "resolved", failure));
session.close();

const directory = mkdtempSync("fetch-schemes-");
const upload = await fetch(`http://localhost:${server.port}/upload`, { method: "POST", body: Bun.file(directory) }).then(() => "resolved", (e: any) => `${e.code} ${e.syscall}`);
console.log("a directory body:", upload);
