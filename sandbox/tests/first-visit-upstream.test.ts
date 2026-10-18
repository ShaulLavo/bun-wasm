import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerHttp2Session, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import test from "node:test";
import { Upstream } from "../../web/tests/first-visit-upstream.ts";

async function read(client: Upstream, url: URL): Promise<string> {
  const pending = client.request(url, { headers: { connection: "keep-alive", host: url.host }, signal: AbortSignal.timeout(2_000) });
  const received = await pending.response;
  assert.equal(received.statusCode, 200);
  let text = "";
  for await (const chunk of received.body) text += chunk;
  return text;
}

test("HTTP/2 asset requests share a connection and filter hop headers", async () => {
  const server = createServer();
  const sessions = new Set<ServerHttp2Session>();
  let connections = 0;
  server.on("session", session => { sessions.add(session); connections++; session.once("close", () => sessions.delete(session)); });
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    stream.once("end", () => { stream.respond({ ":status": 200 }); stream.end(headers[":path"]); });
    stream.resume();
  });
  let client;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = new URL(`http://127.0.0.1:${address.port}/`);
    client = new Upstream(base, "http2");
    const owner = client;
    const paths = Array.from({ length: 12 }, (_, i) => `/${i}`);
    assert.deepEqual(await Promise.all(paths.map(path => read(owner, new URL(path, base)))), paths);
    assert.equal(connections, 1);
    await read(client, new URL("/later", base));
    assert.equal(connections, 1);
  } finally {
    client?.close();
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("closing HTTP/2 upstream cancels pending streams and its socket", async () => {
  const server = createServer();
  const peer = Promise.withResolvers<ServerHttp2Session>();
  server.once("session", peer.resolve);
  server.on("stream", (stream: ServerHttp2Stream) => { stream.respond({ ":status": 200 }); stream.write("pending"); });
  let client, session;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = new URL(`http://127.0.0.1:${address.port}/`);
    client = new Upstream(base, "http2");
    const pending = client.request(base, { headers: {}, signal: AbortSignal.timeout(2_000) });
    pending.writable.end();
    await pending.response;
    session = await peer.promise;
    const closed = once(session, "close", { signal: AbortSignal.timeout(1_000) });
    await Promise.all([closed, Promise.resolve(client.close())]);
    assert.equal(session.destroyed, true);
  } finally {
    client?.close();
    session?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a failed HTTP/2 connection rejects the pending response", { timeout: 2_000 }, async context => {
  const { createServer: tcpServer } = await import("node:net");
  const server = tcpServer(socket => socket.destroy());
  let client: Upstream | undefined;
  context.after(async () => {
    client?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = new URL(`http://127.0.0.1:${address.port}/`);
  client = new Upstream(base, "http2");
  const pending = client.request(base, { headers: {} });
  pending.writable.end();
  await assert.rejects(pending.response, Error);
});
