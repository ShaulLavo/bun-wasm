import assert from "node:assert/strict";
import { NetHost } from "../../src/net/host";
import { networkFixture } from "../node-net-fixture";
import type { NetRequest } from "waffle/browser/net/protocol";

const next = Promise.withResolvers<void>();
self.onmessage = ({ data }: MessageEvent<{ ring: SharedArrayBuffer; mode?: "abstract" } | { continue: true }>) => {
  if ("continue" in data) { next.resolve(); return; }
  const running = data.mode === "abstract" ? abstract(data.ring) : run(data.ring);
  void running.then(value => self.postMessage({ kind: "done", value }), error => self.postMessage({ kind: "error", error: String(error?.stack ?? error) }));
};
type Fixture = ReturnType<typeof networkFixture>;

function released(ring: SharedArrayBuffer): Fixture {
  const host = new NetHost(ring, (req: NetRequest) => self.postMessage({ kind: "net", req }), undefined, { shared: true });
  return networkFixture(host.engineNet().natives);
}

/** A half-close echo server: replies `after EOF:<request>` once the peer ends its write side. */
function echoServer(fixture: Fixture, errors: unknown[]) {
  const server = fixture.own(fixture.net.createServer({ allowHalfOpen: true }, socket => {
    let request = "";
    fixture.own(socket).on("error", error => errors.push(error));
    socket.on("data", bytes => { request += bytes.toString(); });
    socket.on("end", () => socket.end(`after EOF:${request}`));
  }));
  server.on("error", error => errors.push(error));
  return server;
}

async function exchange(fixture: Fixture, name: string, payload: string, errors: unknown[]) {
  let response = "";
  let ended = false;
  const client = fixture.own(fixture.net.connect(name));
  client.on("error", error => errors.push(error));
  client.on("data", bytes => { response += bytes.toString(); });
  client.on("end", () => { ended = true; });
  client.end(payload);
  for (let turn = 0; turn < 100 && !ended; turn++) { await fixture.pump(); await Bun.sleep(1); }
  return { client, response, ended };
}

async function closeServer(fixture: Fixture, server: ReturnType<typeof echoServer>, errors: unknown[]) {
  let closed = false;
  server.close(error => { if (error) errors.push(error); closed = true; });
  for (let turn = 0; turn < 100 && !closed; turn++) await fixture.pump();
  return closed;
}

async function run(ring: SharedArrayBuffer) {
  const fixture = released(ring);
  const errors: unknown[] = [];
  const path = "/run/bun-adapter.sock";
  const payload = "Bun adapter over real Unix ✓";
  try {
    const server = echoServer(fixture, errors);
    server.listen(path);
    await fixture.pump();
    assert.equal(server.address(), path);
    assert.equal(errors.length, 0);
    self.postMessage({ kind: "listening", path });
    await next.promise;
    assert.equal(await rejectedPath(fixture, "/run/missing.sock"), "ENOENT");
    const { client, response, ended } = await exchange(fixture, path, payload, errors);
    assert.equal(errors.length, 0);
    assert.equal(ended, true);
    assert.equal(response, `after EOF:${payload}`);
    assert.equal(client.remoteAddress, undefined);
    const closed = await closeServer(fixture, server, errors);
    assert.equal(closed, true);
    assert.equal(errors.length, 0);
    return { payloadBytes: Buffer.byteLength(payload), halfClose: ended, response, closed };
  } finally { await fixture.dispose(); }
}

/** Abstract names: no filesystem path, no cwd join; the released provider owns the namespace. */
async function abstract(ring: SharedArrayBuffer) {
  const fixture = released(ring);
  const errors: unknown[] = [];
  const name = "\0bun-adapter.sock";
  try {
    const server = echoServer(fixture, errors);
    server.listen(name);
    await fixture.pump();
    assert.equal(errors.length, 0, String(errors[0]));
    const address = server.address();
    const { response } = await exchange(fixture, name, "abstract", errors);
    const closed = await closeServer(fixture, server, errors);
    assert.equal(errors.length, 0, String(errors[0]));
    return { address, response, closed, refused: await rejectedPath(fixture, "\0unbound.sock") };
  } finally { await fixture.dispose(); }
}

async function rejectedPath(fixture: Fixture, path: string): Promise<unknown> {
  const socket = fixture.own(fixture.net.connect({ path }));
  let code: unknown;
  socket.on("error", error => { code = Reflect.get(error, "code"); });
  for (let turn = 0; turn < 100 && !socket.closed; turn++) await fixture.pump();
  assert.equal(socket.closed, true);
  return code;
}
