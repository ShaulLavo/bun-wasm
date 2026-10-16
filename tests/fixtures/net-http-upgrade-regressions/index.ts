import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const resources = new Set<net.Socket | net.Server>();
const own = <T extends net.Socket | net.Server>(resource: T) => {
  resources.add(resource);
  resource.on("error", () => {});
  return resource;
};
const event = (object: NodeJS.EventEmitter, name: string) => new Promise(resolve => object.once(name, resolve));
async function listen(receive: (socket: net.Socket) => void) {
  const server = own(net.createServer(socket => receive(own(socket))));
  server.listen(0, "127.0.0.1");
  await event(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
const headers = { Connection: "Upgrade", Upgrade: "raw" };
async function tls() {
  if (!process.env.BUNWASM_TEST) return;
  let connected = false;
  const port = await listen(() => { connected = true; });
  const request = https.request({ host: "127.0.0.1", port, headers });
  const failure = new Promise<Error & { code?: string }>(resolve => request.once("error", resolve));
  request.end();
  if (request.socket) own(request.socket);
  const error = await failure;
  if (process.env.BUNWASM_TEST) assert.equal(error.code, "ERR_TLS_NOT_SUPPORTED");
  assert.equal(connected, false, "HTTPS upgrade must not establish a plaintext connection");
}
async function validation() {
  assert.equal(http.validateHeaderName("X-Test"), undefined);
  assert.equal(http.validateHeaderValue("X-Test", "yes"), undefined);
  const target = { host: "127.0.0.1", port: 1, headers };
  for (const method of ["GET\r\nInjected: yes", "GET x"]) {
    assert.throws(() => http.request({ ...target, method }), { code: "ERR_INVALID_HTTP_TOKEN" });
  }
  for (const path of ["/a b", "/\r\nInjected: yes", "/\u0100"]) {
    assert.throws(() => http.request({ ...target, path }), { code: "ERR_UNESCAPED_CHARACTERS" });
  }
  assert.throws(() => http.request({ ...target, headers: { "X\r\nInjected": "yes" } }), { code: "ERR_INVALID_HTTP_TOKEN" });
  assert.throws(() => http.request({ ...target, headers: { X: "yes\r\nInjected: yes" } }), { code: "ERR_INVALID_CHAR" });
  const request = http.request(target);
  request.on("error", () => {});
  assert.throws(() => request.setHeader("X", "a\nb"), { code: "ERR_INVALID_CHAR" });
  request.destroy();
}
async function body() {
  let wire = "";
  const port = await listen(socket => socket.on("data", chunk => {
    wire += chunk.toString();
    if (!wire.endsWith("firstsecondthird")) return;
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\n");
  }));
  const request = http.request({ host: "127.0.0.1", port, method: "POST", headers: Object.assign({ "Content-Length": "16" }, headers) });
  const upgraded = new Promise<void>((resolve, reject) => {
    request.on("error", reject);
    request.on("upgrade", (_response, socket) => { own(socket).destroy(); resolve(); });
  });
  request.write("first");
  request.write(Buffer.from("second"));
  request.end("third");
  if (request.socket) own(request.socket);
  await upgraded;
  assert.equal(wire.split("\r\n\r\n")[1], "firstsecondthird");
}
async function response(framing: "length" | "chunked" | "eof") {
  const port = await listen(socket => socket.once("data", () => {
    const frame = framing === "length" ? "Content-Length: 4\r\n" : framing === "chunked" ? "Transfer-Encoding: chunked\r\n" : "";
    socket.write(`HTTP/1.1 200 OK\r\n${frame}\r\n`);
    setTimeout(() => socket.end(framing === "chunked" ? "2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n" : "abcd"), 5);
  }));
  await new Promise<void>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, headers });
    request.on("error", reject);
    request.on("response", message => {
      let received = "";
      message.on("data", chunk => { received += chunk.toString(); });
      message.on("end", () => {
        assert.equal(received, "abcd");
        assert.equal(message.complete, true);
        resolve();
      });
    });
    request.end();
    if (request.socket) own(request.socket);
  });
}
async function unhandled() {
  let peer: net.Socket | undefined;
  const port = await listen(socket => {
    peer = socket;
    socket.once("data", () => socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\n"));
  });
  const request = http.request({ host: "127.0.0.1", port, headers });
  request.on("error", () => {});
  request.end();
  if (!request.socket) await event(request, "socket");
  assert.ok(request.socket);
  own(request.socket);
  await event(request.socket, "close");
  assert.equal(request.socket.destroyed, true);
  assert.ok(peer);
}
async function serverBody() {
  const server = own(http.createServer());
  const received = Promise.withResolvers<{ complete: boolean; body: string; head: string }>();
  server.on("upgrade", (request, socket, head) => {
    own(socket);
    let body = "";
    const complete = request.complete;
    request.on("data", chunk => { body += chunk.toString(); });
    request.on("end", () => received.resolve({ complete, body, head: head.toString() }));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await event(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: address.port, method: "POST", headers: Object.assign({ "Content-Length": "7" }, headers) });
    request.on("error", reject);
    request.on("upgrade", (_response, socket) => { own(socket).destroy(); resolve(); });
    request.end("payload");
  });
  assert.deepEqual(await received.promise, { complete: true, body: "payload", head: "" });
}
const cases = { validation, tls, body, length: () => response("length"), chunked: () => response("chunked"), eof: () => response("eof"), unhandled, serverBody };
let failures = 0;
for (const [name, run] of Object.entries(cases)) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), 1500); });
    await Promise.race([run(), deadline]);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}`);
  } finally {
    clearTimeout(timer);
    for (const resource of resources) {
      if (resource instanceof net.Socket) resource.destroy();
      else resource.close();
    }
    resources.clear();
  }
}
assert.equal(failures, 0);
