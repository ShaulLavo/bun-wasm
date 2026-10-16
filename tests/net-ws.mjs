import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "./node_modules/ws/index.js";
const server = http.createServer();
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on("connection", socket => socket.on("message", data => socket.send(data)));
server.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/echo`, { perMessageDeflate: false });
const done = Promise.withResolvers();
client.on("error", done.reject);
client.on("open", () => client.send("real ws package"));
client.on("message", data => { assert.equal(data.toString(), "real ws package"); client.close(); });
client.on("close", done.resolve);
await done.promise;
await new Promise(resolve => wss.close(resolve));
await new Promise(resolve => server.close(resolve));
console.log("ws package client and server exchange a message and close");

const net = await import("node:net");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
for (const [name, parts, code] of [
  ["empty EOF", [], "ECONNRESET"],
  ["partial EOF", ["HTTP/1.1 101 Switching Protocols\r\nX-Partial: yes"], "ECONNRESET"],
  ["split overflow", ["HTTP/1.1 101 Switching Protocols\r\nX-Pad: ", "x".repeat(8192), "x".repeat(8192), "x".repeat(8192), "\r\n\r\n"], "HPE_HEADER_OVERFLOW"],
]) {
  const peers = [];
  const fixture = net.createServer(peer => {
    peers.push(peer);
    peer.on("error", () => {});
    peer.once("data", async () => {
      for (const part of parts) { peer.write(part); await delay(5); }
      peer.end();
    });
  });
  fixture.listen(0, "127.0.0.1");
  await new Promise(resolve => fixture.once("listening", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${fixture.address().port}`, { perMessageDeflate: false });
  const errors = [];
  let closed = 0;
  socket.on("error", err => errors.push(err));
  socket.on("close", () => closed++);
  try {
    for (let i = 0; i < 200 && !closed; i++) await delay(5);
    assert.equal(socket.readyState, WebSocket.CLOSED, name);
    assert.equal(closed, 1, name);
    assert.equal(errors.length, 1, name);
    assert.equal(errors[0].code, code, name);
    console.log("PASS ws " + name);
  } catch (err) {
    failures++;
    console.log("FAIL ws " + name + " " + err.message);
  } finally {
    socket.terminate();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => fixture.close(resolve));
  }
}
assert.equal(failures, 0, "ws handshake regressions");
