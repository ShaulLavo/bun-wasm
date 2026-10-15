import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
const server = http.createServer();
const done = Promise.withResolvers();
server.on("upgrade", (request, socket, head) => {
  assert.equal(request.url, "/upgrade");
  assert.equal(socket instanceof net.Socket, true);
  let input = head.toString();
  let expected = "first";
  const receive = () => {
    assert.equal(expected.startsWith(input), true);
    if (input !== expected) return;
    input = "";
    if (expected === "first") {
      expected = "next";
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\nreply");
      return;
    }
    socket.end("last");
  };
  socket.on("data", bytes => { input += bytes.toString(); receive(); });
  receive();
});
server.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const client = net.connect({ port: server.address().port, host: "127.0.0.1" });
client.setEncoding("utf8");
let response = "";
client.on("data", data => {
  response += data;
  if (response.endsWith("reply")) client.write("next");
});
client.on("error", done.reject);
client.on("close", done.resolve);
client.write("GET /upgrade HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\nfirst");
await done.promise;
assert.equal(response.endsWith("replylast"), true);
await new Promise(resolve => server.close(resolve));
console.log("HTTP upgrade hands a duplex socket and buffered head to its listener");
