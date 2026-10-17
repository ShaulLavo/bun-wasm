import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

for (const method of ["GET", "HEAD", "DELETE", "OPTIONS", "TRACE", "CONNECT", "POST", "PUT", "PATCH", "PROPFIND"]) {
  for (const mode of ["flush", "write", "end", "empty"]) {
    let wire = "";
    const server = net.createServer(socket => {
      socket.on("data", chunk => wire += chunk);
      socket.once("data", () => setTimeout(() => socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"), 25));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: server.address().port, method, agent: false });
        request.on("error", reject);
        request.on("response", response => { response.resume(); response.on("end", resolve); });
        request.on("connect", (_response, socket) => { socket.destroy(); resolve(); });
        if (mode === "flush") { request.flushHeaders(); request.end(); }
        else if (mode === "write") { request.write("a"); request.end("b"); }
        else request.end(mode === "empty" ? undefined : "ab");
      });
      const bodyMethod = ["POST", "PUT", "PATCH", "PROPFIND"].includes(method);
      const chunked = bodyMethod && (mode === "flush" || mode === "write");
      assert.equal(/Transfer-Encoding: chunked/i.test(wire), chunked, `${method} ${mode}`);
      assert.equal(/Content-Length: 2/i.test(wire), bodyMethod && mode === "end", `${method} ${mode}`);
      assert.equal(/Content-Length: 0/i.test(wire), bodyMethod && mode === "empty", `${method} ${mode}`);
      const body = wire.slice(wire.indexOf("\r\n\r\n") + 4);
      const expected = mode === "empty" ? "" : mode === "flush" ? (chunked ? "0\r\n\r\n" : "") : (chunked ? "1\r\na\r\n1\r\nb\r\n0\r\n\r\n" : "ab");
      assert.equal(body, expected, `${method} ${mode}`);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
}
console.log("HTTP request method framing matches Node");
