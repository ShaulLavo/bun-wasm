import assert from "node:assert/strict";
import http from "node:http";

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
console.log("HTTP Agent reuses framed keep-alive responses");
