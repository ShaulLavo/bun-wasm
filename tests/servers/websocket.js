// Standalone guest server for scripts/test-websocket.mjs.
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req, {
      data: new URL(req.url).pathname,
      headers: req.headers.has("sec-websocket-protocol") ? { "sec-websocket-protocol": "bun-hmr" } : {},
    })) return;
    return new Response("upgrade refused", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) { ws.send(`open:${ws.data}`); },
    message(ws, data) { ws.send(data); },
    ping(ws, data) { ws.send(`ping:${new TextDecoder().decode(data)}`); },
  },
});
console.log(`PORT=${server.port}`);
