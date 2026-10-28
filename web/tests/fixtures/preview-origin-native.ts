import { connect } from "node:net";
import type { PreviewOriginEndpoint } from "../../preview-origin-host";

export function fixture(label: string): PreviewOriginEndpoint {
  let native: ReturnType<typeof Bun.serve> | undefined;
  return {
    async fetch(req) {
      if (new URL(req.url).pathname === "/redirect") return new Response(null, { status: 307, headers: { location: "/nested?value=redirect" } });
      if (new URL(req.url).pathname === "/empty") return new Response(null, { status: 204 });
      return new Response(`${label}:${new URL(req.url).pathname}${new URL(req.url).search}:${await req.text()}`, {
        status: 201, headers: { "x-method": req.method, "x-echo": req.headers.get("x-challenge") ?? "", "set-cookie": "fixture=1; Path=/" },
      });
    },
    upgrade(req, socket, head) {
      native ??= Bun.serve({ hostname: "127.0.0.1", port: 0,
        fetch(req, server) { if (server.upgrade(req, { data: undefined })) return; return new Response(null, { status: 426 }); },
        websocket: { message(socket, message) { socket.send(message); } },
      });
      const upstream = connect(Number(native.port), "127.0.0.1");
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((lines, value, index) => lines + (index % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    },
    async close() { await native?.stop(true); },
  };
}

