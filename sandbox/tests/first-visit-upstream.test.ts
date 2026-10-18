import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { Upstream } from "../../web/tests/first-visit-upstream.ts";

test("upstream returns complete decoded bodies and preserves HTTP status", async () => {
  const text = "complete response ".repeat(1000);
  const server = createServer((_request, response) => {
    response.writeHead(418, { "content-encoding": "gzip", "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] });
    response.end(gzipSync(text));
  });
  let client: Upstream | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    client = await Upstream.create();
    const response = await client.request(new URL(`http://127.0.0.1:${address.port}/`), { headers: {} }).response;
    assert.equal(response.statusCode, 418);
    assert.equal(response.body.toString(), text);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"]);
  } finally {
    await client?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("canceling one upstream request closes its socket without canceling another", async () => {
  const started = Promise.withResolvers<Socket>();
  const server = createServer((request, response) => {
    if (request.url !== "/pending") { response.end("other request"); return; }
    started.resolve(request.socket);
    response.writeHead(200);
    response.write("partial");
  });
  let client: Upstream | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = new URL(`http://127.0.0.1:${address.port}/`);
    client = await Upstream.create();
    const pending = client.request(new URL("/pending", base), { headers: {} });
    pending.response.catch(() => {});
    const socket = await started.promise;
    const closing = Promise.withResolvers<void>();
    socket.once("error", () => {});
    socket.once("close", () => closing.resolve());
    const timeout = AbortSignal.timeout(2_000);
    const closed = Promise.race([closing.promise, once(timeout, "abort").then(() => { throw timeout.reason; })]);
    pending.cancel();
    await Promise.all([closed, assert.rejects(pending.response)]);
    const response = await client.request(base, { headers: {} }).response;
    assert.equal(response.body.toString(), "other request");
  } finally {
    await client?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("upstream connection failures reject and proxy closure rejects new requests", async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.destroy(); });
  let client: Upstream | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = new URL(`http://127.0.0.1:${address.port}/`);
    client = await Upstream.create();
    await assert.rejects(client.request(base, { headers: {} }).response);
    assert.equal(requests, 1);
    await client.close();
    const closed = client;
    assert.throws(() => closed.request(base, { headers: {} }));
  } finally {
    await client?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
