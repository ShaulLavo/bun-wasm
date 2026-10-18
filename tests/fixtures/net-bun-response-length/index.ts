import assert from "node:assert/strict";

const encoder = new TextEncoder();
let controller: ReadableStreamDefaultController<Uint8Array>;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const length = new URL(request.url).pathname.slice(1);
    if (length === "next") return new Response("next");
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
} finally {
  server.stop(true);
}
