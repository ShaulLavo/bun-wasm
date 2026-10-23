import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect } from "node:net";

const server = createServer(peer => peer.end());
let client;
try {
  server.listen(0);
  await once(server, "listening");
  client = connect(server.address().port, "127.0.0.1");
  await once(client, "close");
  assert.equal(client.destroyed, true);
  console.log("default listener accepts IPv4 connections");
} finally {
  client?.destroy();
  await new Promise(resolve => server.close(resolve));
}
