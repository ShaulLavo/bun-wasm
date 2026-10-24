import { expect, test } from "bun:test";
import type { Socket, Server } from "node:net";
import { networkFixture } from "./node-net-fixture";

function connectionCount(server: Server) {
  return new Promise<number>((resolve, reject) => server.getConnections((error, count) => {
    if (error) return reject(error);
    resolve(count);
  }));
}

test("Server keeps snapshotted options on accepted sockets", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const options = { allowHalfOpen: true, pauseOnConnect: true, highWaterMark: 42 };
    const server = own(net.createServer(options, peer => own(peer))).listen(0, "127.0.0.1");
    options.highWaterMark = 91;
    let accepted: Socket | undefined;
    server.on("connection", peer => { accepted = peer; });
    own(net.connect(fixture.port(server), "127.0.0.1"));
    await pump();
    expect(accepted?.readableHighWaterMark).toBe(42);
    expect(accepted?.writableHighWaterMark).toBe(42);
    expect(accepted?.isPaused()).toBe(true);
  } finally { await fixture.dispose(); }
});

test("Server.call initializes an inherited receiver and accepts connections", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const receiver: Server = own(Object.create(net.Server.prototype));
    let connections = 0;
    Reflect.apply(net.Server, receiver, [{ pauseOnConnect: true }, (peer: Socket) => { own(peer); connections++; }]);
    expect(Reflect.get(receiver, "pauseOnConnect")).toBe(true);
    receiver.listen(0, "127.0.0.1");
    own(net.connect(fixture.port(receiver), "127.0.0.1"));
    await pump();
    expect(connections).toBe(1);
    expect(await connectionCount(receiver)).toBe(1);
  } finally { await fixture.dispose(); }
});
