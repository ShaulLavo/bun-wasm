import { expect, test } from "bun:test";
import EventEmitter from "node:events";
import type { Socket, Server } from "node:net";
import { networkFixture } from "./node-net-fixture";

test("Server supports callable construction, subclassing and the public prototype", async () => {
  const fixture = networkFixture();
  const { net, own } = fixture;
  try {
    const server = own(Reflect.apply(net.Server, undefined, []));
    expect(server).toBeInstanceOf(net.Server);
    expect(server.constructor).toBe(net.Server);
    expect(net.Server.length).toBe(2);
    expect(Object.getPrototypeOf(net.Server)).toBe(EventEmitter);
    expect(Object.getPrototypeOf(net.Server.prototype)).toBe(EventEmitter.prototype);
    class Child extends net.Server {}
    const child = own(new Child());
    expect(child).toBeInstanceOf(Child);
    expect(child).toBeInstanceOf(net.Server);
  } finally { await fixture.dispose(); }
});

test("Server rejects primitive options and snapshots constructor options", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    for (const value of [1, false, "string", Symbol("options")]) {
      expect(() => Reflect.construct(net.Server, [value])).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    }
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

test("Server exposes Bun's public option defaults and validates keepalive delay", async () => {
  const fixture = networkFixture();
  const { net, own } = fixture;
  try {
    expect(own(new net.Server())).toMatchObject({ allowHalfOpen: false, pauseOnConnect: false,
      keepAlive: false, keepAliveInitialDelay: 0, highWaterMark: 65536, noDelay: false });
    expect(own(new net.Server({ keepAlive: true, keepAliveInitialDelay: -4, noDelay: true })))
      .toMatchObject({ keepAlive: true, keepAliveInitialDelay: 0, noDelay: true });
    expect(() => Reflect.construct(net.Server, [{ keepAliveInitialDelay: "invalid" }]))
      .toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
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
    await new Promise<void>((resolve, reject) => receiver.getConnections((error, count) => {
      if (error) { reject(error); return; }
      expect(count).toBe(1);
      resolve();
    }));
  } finally { await fixture.dispose(); }
});
