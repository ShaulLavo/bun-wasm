import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const nativeControl = process.env.BUN_WASM_NATIVE_CONTROL === "1";
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 1500); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

function stagedBody() {
  let finish: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      finish = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      }, 30);
    },
  });
  return { stream, clear() { clearTimeout(finish); } };
}

function readBody(response: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  const ended = new Promise<void>((resolve, reject) => {
    response.on("data", chunk => chunks.push(chunk));
    response.on("end", resolve);
    response.on("error", reject);
  });
  return { chunks, ended };
}

async function stagedServer() {
  if (nativeControl) {
    let finish: ReturnType<typeof setTimeout> | undefined;
    const respond = (_request: http.IncomingMessage, response: http.ServerResponse) => {
      response.write("first");
      finish = setTimeout(() => response.end("second"), 30);
    };
    const server = http.createServer(respond);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing staged server address");
    return {
      port: address.port,
      async close() {
        clearTimeout(finish);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      },
    };
  }
  const body = stagedBody();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(body.stream); } });
  return {
    port: server.port,
    async close() { body.clear(); await server.stop(true); },
  };
}

function serveRaw(socket: net.Socket, sockets: Set<net.Socket>, expected: Buffer) {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.once("data", data => {
    const path = data.toString().split(" ")[1];
    if (path === "/timeout") {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.end(Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${expected.length}\r\nConnection: close\r\n\r\n`),
      expected,
    ]));
  });
}

async function checkFetchBackedHttps() {
  const server = await stagedServer();
  let request: http.ClientRequest | undefined;
  let received = "";
  let ended = false;
  let response: http.IncomingMessage | undefined;
  let firstData!: () => void;
  let endedBody!: () => void;
  const first = new Promise<void>(resolve => { firstData = resolve; });
  const end = new Promise<void>(resolve => { endedBody = resolve; });
  const onResponse = (incoming: http.IncomingMessage) => {
    response = incoming;
    incoming.on("data", chunk => {
      received += chunk;
      firstData();
    });
    incoming.on("end", () => { ended = true; endedBody(); });
  };
  try {
    const options = nativeControl
      ? { host: "127.0.0.1", port: server.port, path: "/stream", agent: false } as const
      : { protocol: "https:", href: `http://127.0.0.1:${server.port}/stream` } as const;
    const transport = nativeControl ? http : https;
    request = transport.request(options, onResponse);
    request.on("error", error => { throw error; });
    request.end();
    await deadline(first, "fetch-backed HTTPS first chunk");
    assert.equal(received, "first");
    assert.equal(ended, false);
    assert.equal(response?.complete, false);
    await deadline(end, "fetch-backed HTTPS EOF");
    assert.equal(received, "firstsecond");
    console.log("fetch-backed HTTPS streams before EOF");
  } finally {
    request?.destroy();
    await server.close();
  }
}

async function checkRawHttp() {
  const expected = Buffer.concat(Array.from({ length: 32 }, (_, index) => Buffer.alloc(4096, index)));
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => serveRaw(socket, sockets, expected));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const options = { host: "127.0.0.1", port: address.port, agent: false } as const;
  let request: http.ClientRequest | undefined;
  try {
    let response: http.IncomingMessage | undefined;
    request = http.get({ ...options, path: "/body" }, incoming => { response = incoming; });
    await deadline(new Promise<void>(resolve => request!.once("response", () => resolve())), "raw HTTP response");
    await delay(20);
    assert(response);
    assert.equal(response.complete, false);
    const { chunks, ended } = readBody(response);
    await deadline(ended, "raw HTTP resumed body");
    assert(Buffer.concat(chunks).equals(expected));
    assert.equal(response.complete, true);
    console.log("raw HTTP preserves unread body and completion");

    let timeouts = 0;
    request = http.request({ ...options, path: "/timeout" });
    request.on("error", error => { throw error; });
    request.setTimeout(20, () => timeouts++);
    request.end();
    await deadline(new Promise<void>(resolve => request!.once("timeout", resolve)), "raw HTTP timeout");
    assert.equal(timeouts, 1);
    assert.equal(request.destroyed, false);
    request.setTimeout(10);
    request.setTimeout(0);
    await delay(40);
    assert.equal(timeouts, 1);
    console.log("ClientRequest timeout fires and disables");
  } finally {
    request?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

await checkFetchBackedHttps();
await checkRawHttp();
