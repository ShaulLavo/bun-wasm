import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";

const server = createServer((request, response) => {
  console.log(request.url);
  response.end("ok");
});
await once(server.listen(0, "127.0.0.1"), "listening");
const socket = connect({ port: server.address().port, host: "127.0.0.1" });
let output = "";
const completed = Promise.withResolvers<void>();
socket.on("data", data => {
  output += data.toString();
  if (output.split("HTTP/1.1 200").length === 3) completed.resolve();
});
const deadline = setTimeout(() => completed.reject(new Error("second response missing")), 1000);
try {
  await once(socket, "connect");
  socket.write("POST /ignored HTTP/1.1\r\nHost: localhost\r\nContent-Length: 131072\r\n\r\n");
  socket.write(Buffer.alloc(131072, 120));
  socket.write("GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await completed.promise;
  console.log("two responses");
} finally {
  clearTimeout(deadline);
  socket.destroy();
  server.closeAllConnections();
  server.close();
}

const closing = createServer((_request, response) => {
  response.setHeader("Connection", "close");
  response.end("early");
});
await once(closing.listen(0, "127.0.0.1"), "listening");
const client = connect({ port: closing.address().port, host: "127.0.0.1" });
let reply = "";
client.on("data", bytes => { reply += bytes.toString(); });
const closed = once(client, "end");
const closeDeadline = setTimeout(() => client.destroy(new Error("early response did not close")), 1000);
try {
  await once(client, "connect");
  client.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 131072\r\n\r\n");
  await closed;
  if (!reply.endsWith("early")) throw new Error("missing early response body");
  console.log("early close");
} finally {
  clearTimeout(closeDeadline);
  client.destroy();
  closing.closeAllConnections();
  closing.close();
}
