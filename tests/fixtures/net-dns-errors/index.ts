import assert from "node:assert/strict";

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
  console.log("only a bracketed IPv6 literal is unwrapped");
} finally { listener.stop(true); }
