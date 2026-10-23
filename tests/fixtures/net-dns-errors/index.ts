import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";

const invalid = ["this is not a hostname", "localhost:80", "a..b", "[127.0.0.1]", "[]", "[example.invalid]", "::1/64", "[::1/64]", "::ffff:127.1", "127.0.0.1\n", "a".repeat(64) + ".com"];
function check(error, hostname) {
  assert.equal(error.name, "Error");
  assert.equal(error.code, "ENOTFOUND");
  assert.equal(error.syscall, "getaddrinfo");
  assert.equal(error.hostname, hostname);
  assert.equal(error.message, `getaddrinfo ENOTFOUND ${hostname}`);
}
for (const hostname of invalid) {
  assert.throws(() => Bun.listen({ hostname, port: 0, socket: { data() {} } }), error => { check(error, hostname); return true; });
  let inline = true;
  let callbacks = 0;
  const rejected = Bun.connect({ hostname, port: 80, socket: { data() {}, connectError(_socket, error) {
    assert.equal(inline, false);
    callbacks++;
    check(error, hostname);
  } } });
  inline = false;
  await assert.rejects(rejected, error => { check(error, hostname); return true; });
  assert.equal(callbacks, 1);
}
console.log("invalid hosts fail before listening or dialing, with resolver details");
const accepted = Promise.withResolvers();
const listener = Bun.listen({ hostname: "::1", port: 0, socket: { data() {}, open(socket) { accepted.resolve(); socket.end(); } } });
try {
  const client = await Bun.connect({ hostname: "[::1]", port: listener.port, socket: { data() {} } });
  await accepted.promise;
  client.terminate();
  console.log("Bun.connect accepts bracketed IPv6");
} finally { listener.stop(true); }

assert.throws(() => Bun.listen({ hostname: "[::1]", port: 0, socket: { data() {} } }), error => { check(error, "[::1]"); return true; });
const rejectedServer = net.createServer();
const listenError = once(rejectedServer, "error");
rejectedServer.listen(0, "[::1]");
check((await listenError)[0], "[::1]");
const rejectedSocket = net.connect(80, "[::1]");
const socketError = once(rejectedSocket, "error");
const socketClosed = new Promise(resolve => rejectedSocket.once("close", resolve));
check((await socketError)[0], "[::1]");
await socketClosed;
console.log("Bun.listen and node:net preserve bracketed names");
for (const host of [123, true, {}, []]) {
  assert.throws(() => net.connect({ host, port: 80 }), { code: "ERR_INVALID_ARG_TYPE" });
}
console.log("non-string node:net hosts throw synchronously");
const http = Bun.serve({ hostname: "[::1]", port: 0, fetch: () => new Response("ok") });
http.stop(true);
console.log("Bun.serve accepts bracketed IPv6");
