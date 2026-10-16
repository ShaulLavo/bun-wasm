import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

const malformed = [
  ["Content-Length: -1", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: NaN", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: 1.0", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: +1", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: ", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: 1, 1", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: 18446744073709551616", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: 1\r\nContent-Length: 1", "HPE_UNEXPECTED_CONTENT_LENGTH"],
  ["Content-Length: 1\r\nContent-Length: 2", "HPE_UNEXPECTED_CONTENT_LENGTH"],
  ["Transfer-Encoding: chunked\r\nContent-Length: 1", "HPE_INVALID_CONTENT_LENGTH"],
  ["Content-Length: 1\r\nTransfer-Encoding: chunked", "HPE_INVALID_TRANSFER_ENCODING"],
];
async function exchange(headers: string, expectedError: string | null, expectedBody = "", method = "GET") {
  const sockets = new Set<net.Socket>();
  const wireBody = headers === "Content-Length: 01" ? "1" : "1\r\na\r\n0\r\n\r\n";
  const wire = `HTTP/1.1 200 OK\r\nConnection: close\r\n${headers}\r\n\r\n${wireBody}`;
  const split = wire.indexOf(headers) + Math.max(1, Math.floor(headers.length / 2));
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
  let errors = 0;
  let responses = 0;
  let request;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`framing timeout ${headers}`)), 2000);
      const done = (error?) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      request = http.get({ host: "127.0.0.1", port: server.address().port, agent: false, method }, response => {
        responses++;
        let body = "";
        response.on("data", chunk => body += chunk);
        response.on("error", done);
        response.on("end", () => {
          try { assert.equal(expectedError, null, headers); assert.equal(body, expectedBody, headers); done(); }
          catch (error) { done(error); }
        });
      });
      request.on("error", error => {
        errors++;
        try { assert.equal(error.code, expectedError, headers); done(); }
        catch (error) { done(error); }
      });
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(errors, expectedError ? 1 : 0, headers);
    assert.equal(responses, expectedError ? 0 : 1, headers);
  } finally {
    request?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
for (const [headers, error] of malformed) await exchange(headers, error);
await exchange(malformed[9][0], malformed[9][1], "", "HEAD");
for (const encoding of ["xchunked", "chunked, gzip", "gzip"]) {
  await exchange(`Transfer-Encoding: ${encoding}`, null, "1\r\na\r\n0\r\n\r\n");
}
for (const encoding of ["gzip, chunked", "chunked, chunked"]) {
  await exchange(`Transfer-Encoding: ${encoding}`, null, "a");
}
await exchange("Content-Length: 01", null, "1");
console.log("HTTP split response framing matches Node");
