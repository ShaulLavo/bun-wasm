import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const event = (object, name) => new Promise(resolve => object.once(name, resolve));

function responseBody(request, body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("response", response => {
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ response, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function runResponseCases() {
  const lifecycle = [];
  let streamingResponse;
  const server = http.createServer((req, res) => {
    if (req.url === "/response") {
      assert.equal(req.rawHeaders.includes("X-Request"), true);
      res.on("finish", () => lifecycle.push("finish"));
      res.on("close", () => lifecycle.push("close"));
      res.setHeader("X-Set", ["one", "two"]);
      res.appendHeader("X-Append", ["three", "four"]);
      res.writeHead(200, "Custom", { "Transfer-Encoding": "chunked", "X-Head": "yes" });
      assert.equal(res.headersSent, true);
      assert.throws(() => res.setHeader("X-Late", "no"), error => error.code === "ERR_HTTP_HEADERS_SENT");
      res.addTrailers({ "X-Trailer": "done" });
      res.write("a");
      res.end("b", () => lifecycle.push("callback"));
      return;
    }
    if (req.url === "/head") {
      res.end("head-body");
      return;
    }
    if (req.url === "/no-content") {
      res.statusCode = 204;
      res.write("ignored");
      res.end();
      return;
    }
    if (req.url === "/not-modified") {
      res.statusCode = 304;
      res.end("ignored");
      return;
    }
    if (req.url === "/stream") {
      res.setHeader("X-Stream", "yes");
      res.flushHeaders();
      res.flushHeaders();
      streamingResponse = res;
      res.write("a");
      return;
    }
    if (req.url === "/array") {
      res.setHeader("X-Order", "old");
      res.writeHead(200, ["X-Order", "first", "X-Order", "second", "X-After", "last"]);
      res.end();
      return;
    }
    if (req.url === "/raw-array") {
      res.writeHead(200, ["X-First", "one", "x-first", "two"]);
      assert.deepEqual(res.getHeaderNames(), []);
      res.end();
      return;
    }
    if (req.url === "/length304") {
      res.statusCode = 304;
      res.setHeader("Content-Length", "11");
      res.end("ignored");
      return;
    }
    if (req.url === "/chunked204" || req.url === "/chunked304") {
      res.statusCode = Number(req.url.slice(-3));
      res.setHeader("Transfer-Encoding", "chunked");
      res.end("ignored");
      return;
    }
    if (req.url === "/trailers") {
      req.resume();
      req.on("end", () => {
        assert.deepEqual(req.rawTrailers, ["X-Client", "one", "X-Client", "two"]);
        res.setHeader("Trailer", "X-Server");
        res.addTrailers([["X-Server", "one"], ["X-Server", "two"]]);
        res.end("trailer");
      });
      return;
    }
    if (req.url === "/pipe-one" || req.url === "/pipe-two") {
      res.end(req.url);
      return;
    }
    res.end("unexpected");
  });
  server.on("checkContinue", (req, res) => {
    res.writeContinue();
    req.on("data", () => {});
    req.on("end", () => res.end("continue"));
  });
  server.listen(0, "127.0.0.1");
  await event(server, "listening");
  const port = server.address().port;

  const response = await responseBody(http.request({ host: "127.0.0.1", port, path: "/response", headers: { "X-Request": "case" } }));
  assert.equal(response.body, "ab");
  assert.equal(response.response.statusMessage, "Custom");
  assert.equal(response.response.headers["transfer-encoding"], "chunked");
  assert.equal(response.response.headers["content-length"], undefined);
  assert.equal(response.response.headers["x-append"], "three, four");
  assert.deepEqual(response.response.rawHeaders.slice(0, 12), ["X-Set", "one", "X-Set", "two", "X-Append", "three", "X-Append", "four", "Transfer-Encoding", "chunked", "X-Head", "yes"]);
  assert.deepEqual(response.response.trailers, { "x-trailer": "done" });
  assert.deepEqual(response.response.rawTrailers, ["X-Trailer", "done"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(lifecycle, ["callback", "finish", "close"]);

  const head = await responseBody(http.request({ host: "127.0.0.1", port, method: "HEAD", path: "/head" }));
  assert.equal(head.body, "");
  assert.equal(head.response.headers["content-length"], undefined);

  const noContent = await responseBody(http.request({ host: "127.0.0.1", port, path: "/no-content" }));
  assert.equal(noContent.body, "");
  assert.equal(noContent.response.headers["content-length"], undefined);

  const notModified = await responseBody(http.request({ host: "127.0.0.1", port, path: "/not-modified" }));
  assert.equal(notModified.body, "");
  assert.equal(notModified.response.headers["content-length"], undefined);

  const continued = await responseBody(http.request({ host: "127.0.0.1", port, path: "/continue", method: "POST", headers: { Expect: "100-continue", "Content-Length": "4" } }), "body");
  assert.equal(continued.body, "continue");
  await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/continue", method: "POST", headers: { Expect: "100-continue" } });
    let receivedContinue = false;
    request.on("continue", () => { receivedContinue = true; request.end("body"); });
    request.on("response", response => {
      assert.equal(receivedContinue, true);
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", reject);
  });
  let streamed = "";
  await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/stream" }, response => {
      assert.equal(response.headers["x-stream"], "yes");
      response.on("data", chunk => {
        streamed += chunk.toString();
        if (streamed === "a") streamingResponse.end("b");
      });
      response.on("end", () => { assert.equal(streamed, "ab"); resolve(); });
    });
    request.on("error", reject);
  });
  const array = await responseBody(http.request({ host: "127.0.0.1", port, path: "/array" }));
  assert.deepEqual(array.response.rawHeaders.slice(0, 6), ["X-Order", "first", "X-Order", "second", "X-After", "last"]);
  const rawArray = await responseBody(http.request({ host: "127.0.0.1", port, path: "/raw-array" }));
  assert.deepEqual(rawArray.response.rawHeaders.slice(0, 4), ["X-First", "one", "x-first", "two"]);
  const length304 = await responseBody(http.request({ host: "127.0.0.1", port, path: "/length304" }));
  assert.equal(length304.body, "");
  assert.equal(length304.response.headers["content-length"], "11");
  for (const status of [204, 304]) {
    const chunked = await responseBody(http.request({ host: "127.0.0.1", port, path: `/chunked${status}` }));
    assert.equal(chunked.body, "");
    assert.equal(chunked.response.headers["transfer-encoding"], "chunked");
    assert.equal(chunked.response.headers.connection, "close");
  }
  const trailerRequest = http.request({ host: "127.0.0.1", port, path: "/trailers", method: "POST", headers: { "Transfer-Encoding": "chunked" } });
  trailerRequest.addTrailers({ "X-Client": ["one", "two"] });
  const trailers = await responseBody(trailerRequest, "body");
  assert.deepEqual(trailers.response.rawTrailers, ["X-Server", "one", "X-Server", "two"]);
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let wire = "";
    socket.on("error", reject);
    socket.on("data", data => { wire += data.toString(); });
    socket.on("close", () => {
      assert.equal(wire.split("HTTP/1.1 200 OK").length, 3);
      assert.equal(wire.indexOf("/pipe-one") < wire.indexOf("/pipe-two"), true);
      assert.equal(wire.includes("Connection: close"), true);
      resolve();
    });
    socket.write("GET /pipe-one HTTP/1.1\r\nHost: localhost\r\n\r\nGET /pipe-two HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  });
  await new Promise(resolve => server.close(resolve));
}

async function runUpgradeCases() {
  const server = net.createServer(socket => {
    socket.once("data", data => {
      server.emit("requestChunk");
      const text = data.toString();
      if (text.includes("/upgrade")) {
        assert.equal(text.endsWith("payload"), true);
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\nreply");
        socket.destroy();
      } else {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        socket.destroy();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await event(server, "listening");
  const port = server.address().port;

  const firstRead = event(server, "requestChunk");
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let response = "";
    socket.on("error", reject);
    socket.on("data", chunk => { response += chunk.toString(); });
    socket.on("close", () => {
      try {
        assert.equal(response.startsWith("HTTP/1.1 101"), true);
        assert.equal(response.endsWith("reply"), true);
        resolve();
      } catch (error) { reject(error); }
    });
    socket.on("connect", async () => {
      socket.write("POST /upgrade-fragmented HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: raw\r\nContent-Length: 7\r\n\r\npay");
      await firstRead;
      socket.end("load");
    });
  });

  const upgrade = new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/upgrade", method: "POST", headers: { Connection: "Upgrade", Upgrade: "raw", "Content-Length": "7" } });
    request.on("upgrade", (_response, socket, head) => {
      assert.equal(head.toString(), "reply");
      socket.destroy();
      resolve();
    });
    request.on("error", reject);
    request.end("payload");
  });
  await upgrade;

  const non101 = new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/regular", headers: { Connection: "Upgrade", Upgrade: "raw" } });
    request.on("response", response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => { assert.equal(Buffer.concat(chunks).toString(), "ok"); resolve(); });
    });
    request.on("error", reject);
    request.end();
  });
  await non101;
  await new Promise(resolve => server.close(resolve));
}

async function runValidationCases() {
  assert.throws(() => http.request({ method: "GET\nX", host: "127.0.0.1", port: 1 }), error => error.code === "ERR_INVALID_HTTP_TOKEN");
  assert.throws(() => http.request({ path: "/a b", host: "127.0.0.1", port: 1 }), error => error.code === "ERR_UNESCAPED_CHARACTERS");
  assert.throws(() => http.request({ headers: { "X\r\nY": "yes" }, host: "127.0.0.1", port: 1 }), error => error.code === "ERR_INVALID_HTTP_TOKEN");
  assert.throws(() => http.request({ headers: { "X-Test": "a\r\nb" }, host: "127.0.0.1", port: 1 }), error => error.code === "ERR_INVALID_CHAR");

  await new Promise(resolve => {
    const request = https.request({ host: "127.0.0.1", headers: { Connection: "Upgrade", Upgrade: "raw" } });
    request.once("error", error => {
      if (process.env.BUNWASM_TEST) assert.equal(error.code, "ERR_TLS_NOT_SUPPORTED");
      resolve();
    });
    request.end();
  });
}

await runResponseCases();
await runUpgradeCases();
await runValidationCases();
console.log("HTTP response parity");
