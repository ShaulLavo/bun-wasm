import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = (object, name) => new Promise(resolve => object.once(name, resolve));
const resources = [];
const own = object => {
  resources.push(object);
  if (object instanceof net.Socket) object.on("error", () => {});
  return object;
};
async function listen(listener) {
  const server = own(net.createServer(listener));
  server.listen(0, "127.0.0.1");
  await event(server, "listening");
  return server;
}
function connect(server, options = {}) {
  const socket = own(net.connect(Object.assign({ host: "127.0.0.1", port: server.address().port }, options)));
  socket.on("error", () => {});
  return socket;
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("condition did not complete");
}
async function cleanup() {
  for (const object of resources.splice(0).reverse()) {
    if (typeof object === "function") { await object(); continue; }
    if (object instanceof net.Socket) {
      object.destroy();
      if (object._conn && !object._conn.closed) object._conn.destroy();
    } else if (object.listening) object.close();
  }
  await delay(10);
}
async function pipe() {
  const control = path => fetch(process.env.TEST_SERVER + path).then(response => response.text());
  const { port } = JSON.parse(await control("/tcp-sink"));
  own(() => control("/tcp-sink/close"));
  const destination = own(net.connect({ host: "127.0.0.1", port, highWaterMark: 1024 }));
  await event(destination, "connect");
  const sender = await listen(socket => { own(socket); socket.end(Buffer.alloc(16 * 1024 * 1024, 120)); });
  const source = connect(sender, { highWaterMark: 65536 });
  let chunks = 0;
  let falseWrites = 0;
  let maximum = 0;
  let paused = true;
  const write = destination.write.bind(destination);
  destination.write = chunk => {
    const result = write(chunk);
    if (!result) falseWrites++;
    maximum = Math.max(maximum, destination.writableLength);
    return result;
  };
  source.pipe(destination);
  source.on("data", () => {
    chunks++;
    paused = paused && source.isPaused();
  });
  await until(() => destination._conn.bufferedAmount > 0);
  await delay(40);
  assert.equal(paused, true, "pipe pauses immediately on false write");
  assert.ok(falseWrites > 0);
  assert.ok(maximum <= 65536);
  assert.ok(chunks > 0);
  assert.ok(destination._conn.bufferedAmount > 0, "slow native peer blocks the host write");
  const read = source.bytesRead;
  await delay(30);
  assert.ok(source.bytesRead - read <= 65536, "source stops reading while destination is blocked");
  assert.ok(source.readableLength <= 65536, "paused source queue is bounded");
  const finished = event(destination, "finish");
  await control("/tcp-sink/resume");
  await finished;
  await delay(10);
  assert.equal(source.listenerCount("data"), 1, "pipe removes its forwarding listener");
  assert.equal(destination.listenerCount("drain"), 0);
  const cancelledSource = own(new net.Socket());
  const cancelledDestination = own(new net.Socket());
  cancelledSource.pipe(cancelledDestination);
  const closed = event(cancelledDestination, "close");
  cancelledDestination.destroy();
  await closed;
  assert.equal(cancelledSource.listenerCount("data"), 0);
  assert.equal(cancelledDestination.listenerCount("drain"), 0);
}
async function attempt() {
  let peer;
  const server = await listen(socket => { peer = own(socket); socket.resume(); });
  const socket = own(new net.Socket());
  socket.on("error", () => {});
  let handle;
  socket.on("connectionAttempt", () => { handle = socket._conn; socket.destroy(); });
  const closed = event(socket, "close");
  socket.connect({ host: "127.0.0.1", port: server.address().port });
  await closed;
  assert.ok(handle, "connection is owned before invoking user listener");
  assert.equal(handle.closed, true, "cancelled attempt closes host handle");
  await delay(30);
  const serverClosed = event(server, "close");
  server.close();
  await Promise.race([serverClosed, delay(300).then(() => assert.fail("server close hung after attempt cancellation"))]);
  if (peer) assert.equal(peer.destroyed, true);
}
async function writesCancel() {
  const socket = own(new net.Socket());
  let lookup;
  let calls = 0;
  let failure;
  socket.on("error", () => {});
  socket.connect({ host: "fixture.invalid", port: 1234, lookup(host, options, callback) { lookup = callback; } });
  socket.write("pending", err => { calls++; failure = err; });
  const closed = event(socket, "close");
  socket.destroy();
  lookup(null, "127.0.0.1", 4);
  await closed;
  assert.equal(calls, 1, "cancelled lookup settles write callback");
  assert.equal(failure?.code, "ERR_SOCKET_CLOSED_BEFORE_CONNECTION");
  assert.equal(socket.writableLength, 0);
  assert.equal(socket.writableNeedDrain, false);

}
async function writesBlocked() {
  const server = await listen(peer => { own(peer); peer.pause(); });
  const writer = connect(server);
  await event(writer, "connect");
  let blockedCalls = 0;
  let blockedError;
  writer.write(Buffer.alloc(16 * 1024 * 1024));
  writer.write("blocked", err => { blockedCalls++; blockedError = err; });
  assert.ok(writer._conn.bufferedAmount > 0, "host write is blocked");
  const reason = Object.assign(new Error("cancel blocked write"), { code: "ECANCELED" });
  const writerClosed = event(writer, "close");
  writer.destroy(reason);
  const lengthAfterDestroy = writer.writableLength;
  await writerClosed;
  await delay(20);
  assert.equal(blockedCalls, 1);
  assert.equal(blockedError, reason);
  assert.equal(lengthAfterDestroy, 0, "destroy resets accounting immediately");
  assert.equal(writer.writableLength, 0);
  assert.equal(writer.writableNeedDrain, false);
  assert.equal(writer._conn.bufferedAmount, 0);

}
async function writesFailure() {
  const failed = own(new net.Socket());
  failed.on("error", () => {});
  let failedCalls = 0;
  let failedError;
  failed.connect({ host: "fixture.invalid", port: 1234, lookup(host, options, callback) {
    setTimeout(() => callback(Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })), 5);
  } });
  failed.write("pending", err => { failedCalls++; failedError = err; });
  await event(failed, "close");
  assert.equal(failedCalls, 1);
  assert.equal(failedError?.code, "ENOTFOUND");
  assert.equal(failed.writableLength, 0);
}
async function writesRefused() {
  const server = await listen(() => {});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const socket = own(net.connect({ host: "127.0.0.1", port }));
  let calls = 0;
  let failure;
  socket.write("pending", err => { calls++; failure = err; });
  await event(socket, "close");
  assert.equal(calls, 1, "refused connection settles pending write");
  assert.equal(failure?.code, "ECONNREFUSED");
  assert.equal(socket.writableLength, 0);
}
async function read() {
  let peer;
  const server = await listen(socket => { peer = own(socket); socket.write("ab"); });
  const socket = connect(server);
  socket.pause();
  await until(() => socket.readableLength === 2);
  assert.equal(socket.read(4), null, "read waits for a whole header");
  peer.write("cdef");
  await until(() => socket.readableLength === 6);
  assert.equal(socket.read(4).toString(), "abcd");
  assert.equal(socket.readableLength, 2);
  assert.equal(socket.read(3), null);
  peer.end();
  await until(() => socket._ended);
  assert.equal(socket.read(3).toString(), "ef", "EOF permits short read");
}
async function timeout() {
  const socket = own(new net.Socket());
  let cancelled = 0;
  let active = 0;
  const callback = () => cancelled++;
  socket.setTimeout(10, callback);
  socket.setTimeout(0, callback);
  assert.equal(socket.listenerCount("timeout"), 0);
  await delay(20);
  assert.equal(cancelled, 0);
  socket.setTimeout(10, () => active++);
  await delay(30);
  assert.equal(active, 1);
  assert.equal(cancelled, 0);
}
async function sendResponse(socket, parts, keepOpen) {
  for (const part of parts) { socket.write(part); await delay(5); }
  if (!keepOpen) socket.end();
}
async function requestUpgrade(response, options = {}) {
  const server = await listen(socket => {
    own(socket);
    socket.once("data", () => sendResponse(socket, response, options.keepOpen));
    socket.on("error", () => {});
  });
  const req = http.request(Object.assign({ host: "127.0.0.1", port: server.address().port, headers: { Connection: "Upgrade", Upgrade: "raw" } }, options));
  const errors = [];
  let upgraded;
  req.on("error", err => errors.push(err));
  req.on("upgrade", (message, socket, head) => { upgraded = { message, socket, head }; });
  req.end();
  own(req.socket);
  await until(() => errors.length || upgraded);
  await delay(20);
  return { req, errors, upgraded };
}
async function checkEof(parts) {
  const { req, errors, upgraded } = await requestUpgrade(parts);
  assert.equal(upgraded, undefined);
  assert.equal(errors.length, 1, "premature EOF fails once without a handshake timeout");
  assert.equal(errors[0].code, "ECONNRESET");
  assert.equal(req.socket.destroyed, true);
}
async function eofEmpty() { await checkEof([]); }
async function eofPartial() { await checkEof(["HTTP/1.1 101 Switching Protocols\r\nX-Partial: yes"]); }
async function headersDefault() {
  const parts = ["HTTP/1.1 101 Switching Protocols\r\nX-Pad: ", "x".repeat(8192), "x".repeat(8192), "x".repeat(8192), "\r\n\r\n"];
  const overflow = await requestUpgrade(parts);
  assert.equal(overflow.errors[0]?.code, "HPE_HEADER_OVERFLOW");
  assert.equal(overflow.req.socket.destroyed, true);
  assert.equal(overflow.upgraded, undefined);
}
async function headersConfigured() {
  const configured = await requestUpgrade(["HTTP/1.1 101 Switching Protocols\r\nX-Pad: ", "x".repeat(256), "\r\n\r\n"], { maxHeaderSize: 128 });
  assert.equal(configured.errors[0]?.code, "HPE_HEADER_OVERFLOW");
}
async function headersHead() {
  const head = "z".repeat(32 * 1024);
  const valid = await requestUpgrade(["HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\n" + head], { maxHeaderSize: 128, keepOpen: true });
  assert.equal(valid.errors.length, 0);
  assert.equal(valid.upgraded.head.toString(), head, "upgrade head does not count toward the header limit");
  assert.equal(valid.req.socket.listenerCount("data"), 0);
  assert.equal(valid.req.socket.listenerCount("end"), 0);
  assert.equal(valid.req.socket.listenerCount("close"), 0);
  valid.upgraded.socket.destroy();
}
async function blocklist() {
  let connections = 0;
  const server = await listen(socket => { own(socket); connections++; socket.end(); });
  const blocked = new net.BlockList();
  blocked.addAddress("127.0.0.1");
  const socket = connect(server, { host: "127.1", blockList: blocked });
  let connected = false;
  let failure;
  socket.on("connect", () => { connected = true; });
  socket.on("error", err => { failure = err; });
  await event(socket, "close");
  await delay(20);
  assert.equal(connected, false, "hostname/legacy numeric spelling cannot bypass BlockList");
  assert.equal(failure?.code, "ERR_IP_BLOCKED");
  assert.equal(connections, 0);
  const custom = connect(server, { host: "fixture.invalid", blockList: blocked, lookup(host, options, callback) {
    setTimeout(() => callback(null, "127.0.0.1", 4), 5);
  } });
  let customError;
  custom.on("error", err => { customError = err; });
  await event(custom, "close");
  assert.equal(customError?.code, "ERR_IP_BLOCKED");
  assert.equal(connections, 0);
}

let failures = 0;
for (const [name, run] of Object.entries({ pipe, attempt, writesCancel, writesBlocked, writesFailure, writesRefused, read, timeout, eofEmpty, eofPartial, headersDefault, headersConfigured, headersHead, blocklist })) {
  try {
    await run();
    console.log("PASS " + name);
  } catch (err) {
    failures++;
    console.log("FAIL " + name + " " + err.message.split("\n")[0]);
  } finally {
    await cleanup();
  }
}
assert.equal(failures, 0, "TCP review regressions");
