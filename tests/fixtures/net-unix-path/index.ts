import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";

const directory = process.env.BUN_WASM_UNIX_TEST_DIR || "/tmp";
mkdirSync(directory, { recursive: true });
const path = `${directory}/bunwasm-unix.sock`;
const sockets = new Set<Socket>();
const server = createServer({ allowHalfOpen: true }, socket => {
  sockets.add(socket);
  let received = "";
  socket.on("data", bytes => { received += bytes.toString(); });
  socket.on("end", () => socket.end(`echo:${received}`));
  socket.once("close", () => sockets.delete(socket));
});
function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
try {
  server.listen(path);
  await once(server, "listening");
  assert.equal(server.address(), path);
  const client = createConnection(path);
  sockets.add(client);
  let received = "";
  client.on("data", bytes => { received += bytes.toString(); });
  const closed = once(client, "close");
  client.end("request");
  await closed;
  sockets.delete(client);
  assert.equal(received, "echo:request");
  assert.equal(client.remoteAddress, undefined);
  await closeServer();
  assert.equal(existsSync(path), false);
  console.log("unix path echo, half-close and unlink ok");
} finally {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await closeServer();
}
