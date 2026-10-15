// Local HTTP server for the networking fixtures (scripts/test.sh starts it;
// tests never touch the public internet). Prints its port on stdout.
import { gzipSync } from "node:zlib";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/websocket" && srv.upgrade(req)) return;
    switch (url.pathname) {
      case "/text":
        return new Response("hello from the test server");
      case "/json":
        return Response.json({ ok: true, list: [1, 2, 3] });
      case "/echo": {
        const headers = Object.fromEntries(Array.from(req.headers).filter(([k]) => k.startsWith("x-") || k === "content-type"));
        return Response.json({ method: req.method, path: url.pathname + url.search, headers, body: await req.text() });
      }
      case "/bytes":
        return new Response(new Uint8Array([0, 1, 2, 253, 254, 255]), { headers: { "content-type": "application/octet-stream" } });
      case "/gzip":
        return new Response(gzipSync("compressed body ".repeat(20)), { headers: { "content-encoding": "gzip", "content-type": "text/plain" } });
      case "/redirect":
        return Response.redirect("/text", 302);
      case "/status":
        return new Response("teapot", { status: 418, statusText: "I'm a Teapot", headers: { "x-custom": "yes" } });
      case "/slow":
        await Bun.sleep(100);
        return new Response("slow done");
      default:
        return new Response("not found", { status: 404 });
    }
  },
  websocket: {
    message(ws, data) { ws.send(data); },
  },
});
console.log(server.port);
