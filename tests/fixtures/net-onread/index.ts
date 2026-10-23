import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect } from "node:net";

const peers = new Set();
let connections = 0;
const server = createServer(peer => {
  peers.add(peer);
  peer.on("error", () => {});
  if (++connections === 2) peer.end("hello");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const chunks = [];
const backing = Buffer.alloc(2);
const first = Promise.withResolvers();
const client = connect({ port, host: "127.0.0.1", onread: {
  buffer: backing,
  callback(count, bytes) {
    assert.equal(bytes, backing);
    chunks.push(Buffer.from(bytes).toString("utf8", 0, count));
    first.resolve();
    return chunks.length !== 1;
  },
} });
let early = false;
client.on("data", () => { early = true; });
try {
  await once(client, "connect");
  client.pause();
  client.unref();
  client.connect({ port, host: "127.0.0.1" });
  await once(client, "connect");
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.equal(chunks.length, 0);
  assert.equal(client.bytesRead, 0);
  console.log("paused reconnect does not deliver early");
  client.ref();
  client.resume();
  await first.promise;
  assert.deepEqual(chunks, ["he"]);
  assert.equal(client.isPaused(), true);
  assert.equal(client.bytesRead, 2);
  console.log("callback false stops bounded reads");
  client.resume();
  await once(client, "close");
  assert.deepEqual(chunks, ["he", "ll", "o"]);
  assert.equal(client.bytesRead, 5);
  assert.equal(early, false);
  console.log("resume delivers remaining callback bytes and EOF");
} finally {
  client.destroy();
  for (const peer of peers) peer.destroy();
  await new Promise(resolve => server.close(resolve));
}
