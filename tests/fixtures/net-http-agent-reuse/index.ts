import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

for (const mode of ["fixed", "chunked", "HEAD", "204", "304"]) {
  const agent = new http.Agent({ keepAlive: true });
  let connections = 0;
  const server = http.createServer((req, res) => {
    if (mode === "HEAD") res.setHeader("Content-Length", "1");
    if (mode === "204" || mode === "304") res.statusCode = Number(mode);
    if (mode === "chunked") res.write("a");
    res.end("b");
  });
  server.on("connection", () => connections++);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const request = () => new Promise<http.ClientRequest>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.address().port, agent, method: mode === "HEAD" ? "HEAD" : "GET" }, res => {
      res.resume();
      res.on("end", () => { assert.equal(req.socket.destroyed, false, mode); resolve(req); });
    });
    req.on("error", reject);
  });
  try {
    const first = await request();
    await new Promise(resolve => setImmediate(resolve));
    const second = await request();
    assert.ok(first.socket === second.socket, mode);
    assert.equal(second.reusedSocket, true, mode);
    assert.equal(connections, 1, mode);
    agent.destroy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.socket.destroyed, true, mode);
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
for (const mode of ["request-close", "response-close", "eof", "http10", "http10-keepalive", "remote-close", "idle-data", "idle-timeout", "agent-false"]) {
  const agent = new http.Agent({ keepAlive: true, timeout: mode === "idle-timeout" ? 20 : 0 });
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      const version = mode.startsWith("http10") ? "1.0" : "1.1";
      const connection = mode === "response-close" ? "Connection: close\r\n" : mode === "http10-keepalive" ? "Connection: keep-alive\r\n" : "";
      const length = mode === "eof" ? "" : "Content-Length: 1\r\n";
      socket.write(`HTTP/${version} 200 OK\r\n${connection}${length}\r\nx`);
      if (["request-close", "response-close", "eof", "http10", "agent-false"].includes(mode)) socket.end();
      if (mode === "remote-close") setTimeout(() => socket.end(), 10);
      if (mode === "idle-data") setTimeout(() => { if (!socket.destroyed) socket.write("unexpected"); }, 10);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const request = () => new Promise<http.ClientRequest>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.address().port, agent: mode === "agent-false" ? false : agent, headers: mode === "request-close" ? { Connection: "close" } : {} }, res => {
      res.resume();
      res.on("end", () => resolve(req));
    });
    req.on("error", reject);
  });
  try {
    const first = await request();
    await new Promise(resolve => setTimeout(resolve, 60));
    const keepAlive = mode === "http10-keepalive";
    assert.equal(first.socket.destroyed, !keepAlive, mode);
    const second = await request();
    assert.equal(connections, keepAlive ? 1 : 2, mode);
    assert.equal(second.reusedSocket, keepAlive, mode);
  } finally {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
console.log("HTTP Agent reuses framed keep-alive responses");
