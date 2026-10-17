import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

async function check(status: number, method: string, fields: string[]) {
  const sockets = new Set<net.Socket>();
  const wire = `HTTP/1.1 ${status} OK\r\n${fields.join("\r\n")}\r\nConnection: close\r\n\r\nx`;
  const split = wire.indexOf("Transfer-Encoding:") + "Transfer-Encoding:".length;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(wire.slice(0, split));
      setTimeout(() => { if (!socket.destroyed) socket.end(wire.slice(split)); }, 5);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let request;
  let responses = 0;
  let information = 0;
  let upgrades = 0;
  let errors = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${status}/${method} no parser error`)), 2000);
      request = http.get({ host: "127.0.0.1", port: server.address().port, method, agent: false });
      request.on("response", res => { responses++; res.resume(); });
      request.on("information", () => information++);
      request.on("upgrade", (_res, socket) => { upgrades++; socket.destroy(); });
      request.on("error", error => {
        errors++;
        clearTimeout(timer);
        try {
          assert.equal(error.code, "HPE_INVALID_TRANSFER_ENCODING");
          assert.equal(error.message, "Parse Error: Empty Transfer-Encoding");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(errors, 1);
    assert.equal(responses, 0);
    assert.equal(information, 0);
    assert.equal(upgrades, 0);
  } finally {
    request?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
for (const status of [100, 101, 200, 204, 304]) {
  for (const value of ["", " \t"]) await check(status, "GET", [`Transfer-Encoding:${value}`]);
}
await check(200, "HEAD", ["Transfer-Encoding:"]);
await check(200, "GET", ["Transfer-Encoding:", "Transfer-Encoding: chunked"]);
await check(200, "GET", ["Transfer-Encoding: chunked", "Transfer-Encoding:"]);
console.log("HTTP empty transfer encoding rejects before response information or upgrade");
