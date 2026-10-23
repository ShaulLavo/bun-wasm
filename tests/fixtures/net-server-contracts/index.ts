import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { once } from "node:events";
import { Server } from "node:net";

const server = Reflect.apply(Server, undefined, []);
assert.ok(server instanceof Server);
assert.equal(server.constructor, Server);
assert.equal(Server.length, 2);
assert.equal(Object.getPrototypeOf(Server), EventEmitter);
class Child extends Server {}
assert.ok(new Child() instanceof Child);
for (const value of [1, false, "string", Symbol("options")]) {
  assert.throws(() => Reflect.construct(Server, [value]), { code: "ERR_INVALID_ARG_TYPE" });
}
assert.equal(server.keepAlive, false);
assert.equal(server.keepAliveInitialDelay, 0);
assert.equal(server.noDelay, false);
assert.equal(server.highWaterMark, 65536);
console.log("callable Server validates options and preserves public defaults");
try {
  server.listen(0);
  await once(server, "listening");
  assert.equal(server.address().address, "::");
  assert.equal(server.address().family, "IPv6");
  console.log("unspecified listener uses IPv6 any address");
} finally { await new Promise(resolve => server.close(resolve)); }
