import assert from "node:assert/strict";
import { NetHost } from "../../src/net/host";
import { networkFixture } from "../node-net-fixture";
import type { NetRequest } from "waffle/browser/net/protocol";

const next = Promise.withResolvers<void>();
self.onmessage = ({ data }: MessageEvent<{ ring: SharedArrayBuffer } | { continue: true }>) => {
  if ("continue" in data) { next.resolve(); return; }
  void run(data.ring).then(value => self.postMessage({ kind: "done", value }), error => self.postMessage({ kind: "error", error: String(error?.stack ?? error) }));
};
async function run(ring: SharedArrayBuffer) {
  const host = new NetHost(ring, (req: NetRequest) => self.postMessage({ kind: "net", req }), undefined, { shared: true });
  const fixture = networkFixture(host.engineNet().natives);
  const errors: unknown[] = [];
  const path = "/run/bun-adapter.sock";
  const payload = "Bun adapter over real Unix ✓";
  let request = "";
  let response = "";
  let ended = false;
  try {
    const server = fixture.own(fixture.net.createServer({ allowHalfOpen: true }, socket => {
      fixture.own(socket).on("error", error => errors.push(error));
      socket.on("data", bytes => { request += bytes.toString(); });
      socket.on("end", () => socket.end(`after EOF:${request}`));
    }));
    server.on("error", error => errors.push(error));
    server.listen(path);
    await fixture.pump();
    assert.equal(server.address(), path);
    assert.equal(errors.length, 0);
    self.postMessage({ kind: "listening", path });
    await next.promise;
    assert.equal(await rejectedPath(fixture, "/run/missing.sock"), "ENOENT");
    assert.equal(await rejectedPath(fixture, "\0abstract"), "EINVAL");
    const client = fixture.own(fixture.net.connect(path));
    client.on("error", error => errors.push(error));
    client.on("data", bytes => { response += bytes.toString(); });
    client.on("end", () => { ended = true; });
    client.end(payload);
    for (let turn = 0; turn < 100 && !ended; turn++) { await fixture.pump(); await Bun.sleep(1); }
    assert.equal(errors.length, 0);
    assert.equal(ended, true);
    assert.equal(response, `after EOF:${payload}`);
    assert.equal(client.remoteAddress, undefined);
    let closed = false;
    server.close(error => { if (error) errors.push(error); closed = true; });
    for (let turn = 0; turn < 100 && !closed; turn++) await fixture.pump();
    assert.equal(closed, true);
    assert.equal(errors.length, 0);
    return { payloadBytes: Buffer.byteLength(payload), halfClose: ended, response, closed };
  } finally { await fixture.dispose(); }
}


async function rejectedPath(fixture: ReturnType<typeof networkFixture>, path: string): Promise<unknown> {
  const socket = fixture.own(fixture.net.connect({ path }));
  let code: unknown;
  socket.on("error", error => { code = Reflect.get(error, "code"); });
  for (let turn = 0; turn < 100 && !socket.closed; turn++) await fixture.pump();
  assert.equal(socket.closed, true);
  return code;
}
