import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect } from "node:net";

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
  await first.promise;
  assert.deepEqual(chunks, ["he"]);
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(chunks, ["he"]);
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
