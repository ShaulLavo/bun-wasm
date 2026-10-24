import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { once } from "node:events";
import { Server, connect, type Socket } from "node:net";

const server: Server = Reflect.apply(Server, undefined, []);
assert.ok(server instanceof Server);
assert.equal(server.constructor, Server);
assert.equal(Server.length, 2);
assert.equal(Object.getPrototypeOf(Server), EventEmitter);
class Child extends Server {}
assert.ok(new Child() instanceof Child);
for (const value of [1, false, "string", Symbol("options")]) {
  assert.throws(() => Reflect.construct(Server, [value]), { code: "ERR_INVALID_ARG_TYPE" });
}
assert.equal(Reflect.get(server, "keepAlive"), false);
assert.equal(Reflect.get(server, "keepAliveInitialDelay"), 0);
assert.equal(Reflect.get(server, "noDelay"), false);
assert.equal(Reflect.get(server, "highWaterMark"), 65536);
console.log("callable Server validates options and preserves public defaults");
try {
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "::");
  assert.equal(address.family, "IPv6");
  console.log("unspecified listener uses IPv6 any address");
} finally { await new Promise(resolve => server.close(resolve)); }


function LegacyServer(this: Server) { Server.call(this, { pauseOnConnect: true }); }
Object.setPrototypeOf(LegacyServer.prototype, Server.prototype);
const legacy: Server = Reflect.construct(LegacyServer, []);
const peers = new Set<Socket>();
let client;
try {
  assert.equal(Reflect.get(legacy, "pauseOnConnect"), true);
  legacy.on("connection", peer => { peers.add(peer); peer.end(); });
  legacy.listen(0, "127.0.0.1");
  await once(legacy, "listening");
  const address = legacy.address();
  assert.ok(address && typeof address !== "string");
  client = connect(address.port, "127.0.0.1");
  await once(client, "close");
  assert.equal(peers.size, 1);
  console.log("legacy Server.call initializes the receiver and accepts connections");
} finally {
  client?.destroy();
  for (const peer of peers) peer.destroy();
  await new Promise(resolve => legacy.close(resolve));
}
