import assert from "node:assert/strict";
import net from "node:net";

const encoder = new TextEncoder();
let controller: ReadableStreamDefaultController<Uint8Array>;

function delayedResponse(length: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(source) {
      source.enqueue(encoder.encode("a"));
      setTimeout(() => { source.enqueue(encoder.encode("bc")); source.close(); }, 5);
    },
  });
  return new Response(body, { headers: { "content-length": length } });
}

function reusedReplies(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let wire = "";
    let sentNext = false;
    socket.on("error", reject);
    socket.on("data", bytes => {
      wire += bytes.toString();
      if (sentNext || !wire.includes("\r\n0\r\n\r\n")) return;
      sentNext = true;
      socket.write("GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    socket.on("end", () => resolve(wire));
  });
}

async function sameSocket(length: string): Promise<void> {
  const socket = net.connect(server.port, "127.0.0.1");
  const deadline = setTimeout(() => socket.destroy(new Error("response framing did not finish")), 1000);
  try {
    const replies = reusedReplies(socket);
    socket.on("connect", () => socket.write(`GET /reuse/${length} HTTP/1.1\r\nHost: localhost\r\n\r\n`));
    const wire = await replies;
    const firstHead = wire.slice(0, wire.indexOf("\r\n\r\n")).toLowerCase();
    assert(!firstHead.includes("content-length"));
    assert(firstHead.includes("transfer-encoding: chunked"));
    assert.equal(wire.match(/HTTP\/1\.1 200/g)?.length, 2);
    assert(wire.includes("0\r\n\r\nHTTP/1.1"));
    assert(wire.endsWith("next"));
    console.log("same socket length", JSON.stringify(length), "abc next");
  } finally { clearTimeout(deadline); socket.destroy(); }
}
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const length = new URL(request.url).pathname.slice(1);
    if (length === "next") return new Response("next");
    if (length.startsWith("reuse/")) return delayedResponse(length.slice(6));
    return new Response(new ReadableStream<Uint8Array>({
      start(source) { controller = source; source.enqueue(encoder.encode("a")); },
    }), { headers: { "content-length": length } });
  },
});

try {
  for (const length of [1, 3, 5]) {
    const response = await fetch(new URL(String(length), server.url), { signal: AbortSignal.timeout(1000) });
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("transfer-encoding"), "chunked");
    controller!.enqueue(encoder.encode("bc"));
    controller!.close();
    assert.equal(await response.text(), "abc");
    assert.equal(await (await fetch(new URL("next", server.url))).text(), "next");
    console.log("stream length", length, "chunked abc next");
  }
  for (const length of ["1", "5", "-1", "abc"]) await sameSocket(length);
} finally {
  server.stop(true);
}
