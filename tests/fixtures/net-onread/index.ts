import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect, Socket } from "node:net";

const peers = new Set();
const server = createServer(peer => {
  peers.add(peer);
  peer.on("error", () => {});
  peer.end("hello");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const chunks = [];
const backing = Buffer.alloc(2);
const first = Promise.withResolvers();
const second = Promise.withResolvers();
const client = connect({ port, host: "127.0.0.1", onread: {
  buffer: backing,
  callback(count, bytes) {
    assert.equal(bytes, backing);
    chunks.push(Buffer.from(bytes).toString("utf8", 0, count));
    if (chunks.length === 1) first.resolve();
    if (chunks.length === 2) second.resolve();
    return chunks.length > 2;
  },
} });
let early = false;
let pauses = 0;
client.on("pause", () => { pauses++; });
client.on("data", () => { early = true; });
try {
  await first.promise;
  assert.deepEqual(chunks, ["he"]);
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(chunks, ["he"]);
  assert.equal(client.bytesRead, 2);
  assert.equal(client.isPaused(), false);
  assert.equal(pauses, 0);
  console.log("callback false stops the handle without pausing");
  client.read(0);
  await second.promise;
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(chunks, ["he", "ll"]);
  assert.equal(client.isPaused(), false);
  assert.equal(pauses, 0);
  console.log("read(0) restarts bounded callback reads");
  client.resume();
  await once(client, "close");
  assert.deepEqual(chunks, ["he", "ll", "o"]);
  assert.equal(client.bytesRead, 5);
  assert.equal(early, false);
  console.log("resume delivers remaining callback bytes and EOF");
  const nullSocket = new Socket(null);
  assert.equal(nullSocket.readable, true);
  nullSocket.destroy();
  await once(nullSocket, "close");
  console.log("Socket accepts null options");
  const aborted = connect({ port, host: "127.0.0.1", signal: AbortSignal.abort() });
  let closes = 0;
  const errors = [];
  aborted.on("error", error => { errors.push(error.code); });
  aborted.on("close", () => { closes++; });
  await new Promise(resolve => aborted.once("close", resolve));
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.equal(closes, 1);
  assert.deepEqual(errors, ["ABORT_ERR"]);
  console.log("pre-aborted signal closes once");
} finally {
  client.destroy();
  for (const peer of peers) peer.destroy();
  await new Promise(resolve => server.close(resolve));
}
