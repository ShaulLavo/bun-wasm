import assert from "node:assert/strict";
const { promise, resolve, reject } = Promise.withResolvers();
const server = Bun.listen({
  hostname: "127.0.0.1", port: 0, data: { server: true },
  socket: {
    data(socket, data) { assert.equal(socket.data.server, true); socket.write(data); },
    end(socket) { socket.end("tail"); },
    error(socket, error) { reject(error); },
  },
});
let text = "";
const client = await Bun.connect({ hostname: "127.0.0.1", port: server.port, data: "client", socket: {
  open(socket) { assert.equal(socket.data, "client"); socket.write("hello"); },
  data(socket, data) { text += Buffer.from(data).toString(); if (text === "hello") socket.end(); },
  close() { resolve(); },
  error(socket, error) { reject(error); },
} });
await promise;
assert.equal(text, "hellotail");
assert.equal(client.bytesWritten, 5);
server.stop(true);
console.log("Bun TCP callbacks, data and half-close ok");
