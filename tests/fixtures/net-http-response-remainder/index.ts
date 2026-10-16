import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function check(mode: string, delivery: string, suffix = "EXTRA", connection = "keep-alive", version = "1.1") {
  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set<net.Socket>();
  let connections = 0;
  let requests = 0;
  const status = mode === "204" ? "204 No Content" : mode === "304" ? "304 Not Modified" : "200 OK";
  const framing = mode === "chunked" ? "Transfer-Encoding: chunked\r\n" : mode === "fixed" || mode === "HEAD" ? "Content-Length: 1\r\n" : "";
  const body = mode === "fixed" ? "x" : mode === "chunked" ? "1\r\nx\r\n0\r\n\r\n" : "";
  const wire = `HTTP/${version} ${status}\r\n${framing}${connection ? `Connection: ${connection}\r\n` : ""}\r\n${body}`;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = "";
    socket.on("data", chunk => {
      pending += chunk;
      if (!pending.includes("\r\n\r\n")) return;
      pending = "";
      if (++requests !== 1) { socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: keep-alive\r\n\r\ny"); return; }
      if (delivery === "same" || delivery === "paused") { socket.write(wire + suffix); return; }
      if (delivery === "split") {
        const split = wire.indexOf("\r\n\r\n") + 2;
        socket.write(wire.slice(0, split));
        setTimeout(() => { if (!socket.destroyed) socket.write(wire.slice(split) + suffix); }, 5);
        return;
      }
      socket.write(wire);
      setTimeout(() => { if (!socket.destroyed) socket.write(suffix); }, 10);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const errors: string[] = [];
  const errorCompletes: boolean[] = [];
  const request = (first: boolean) => new Promise<{ req: http.ClientRequest; body: string; responses: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${mode}/${delivery} response did not end`)), 2000);
    let responses = 0;
    let complete = () => false;
    const req = http.get({ host: "127.0.0.1", port: server.address().port, agent, method: first && mode === "HEAD" ? "HEAD" : "GET" }, res => {
      complete = () => res.complete;
      responses++;
      let body = "";
      res.on("data", chunk => body += chunk);
      if (first && delivery === "paused") { res.pause(); setTimeout(() => res.resume(), 40); }
      res.on("error", error => { clearTimeout(timer); reject(error); });
      res.on("end", () => { clearTimeout(timer); resolve({ req, body, responses }); });
    });
    req.on("error", error => {
      if (first && ["HPE_INVALID_CONSTANT", "HPE_CLOSED_CONNECTION"].includes(error.code)) {
        errors.push(error.code);
        errorCompletes.push(complete());
        return;
      }
      clearTimeout(timer);
      reject(error);
    });
  });
  try {
    const first = await request(true);
    await pause(60);
    const second = await request(false);
    assert.equal(first.body, mode === "fixed" || mode === "chunked" ? "x" : "", `${mode}/${delivery}`);
    assert.equal(first.responses, 1, `${mode}/${delivery}`);
    assert.equal(first.req.socket.destroyed, true, `${mode}/${delivery} contaminated socket stayed open`);
    assert.equal(second.req.reusedSocket, false, `${mode}/${delivery} reused contaminated connection`);
    assert.equal(connections, 2, `${mode}/${delivery}`);
    assert.equal(second.body, "y", `${mode}/${delivery}`);
    assert.ok(errorCompletes.every(complete => complete), `${mode}/${delivery} response incomplete at parser error`);
    const closed = connection === "close" || version === "1.0";
    if (delivery !== "idle" && (suffix === "EXTRA" || closed)) assert.deepEqual(errors, [closed ? "HPE_CLOSED_CONNECTION" : "HPE_INVALID_CONSTANT"]);
  } finally {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
for (const mode of ["fixed", "chunked", "HEAD", "204", "304"]) {
  for (const delivery of ["same", "split", "idle", "paused"]) await check(mode, delivery);
  await check(mode, "same", "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nz");
}
await check("fixed", "same", "EXTRA", "close");
await check("fixed", "same", "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nz", "close");
await check("fixed", "same", "EXTRA", "", "1.0");
console.log("HTTP response remainder closes contaminated sockets without losing body or EOF");
