// Bun worker that plays the page's role for scripts/run.ts: it receives the guest's NetRequests,
// does real fetches with Bun's fetch, and serves each guest listener on a real local port (the
// browser uses a service worker for that). The wasm runs on the main thread, blocked, so this has
// to be another thread.
import { NetHelper, type PreviewSink } from "../src/net/helper";
import type { NetRequest } from "../src/net/protocol";

declare const self: Worker;

type Init = { type: "init"; ring: SharedArrayBuffer };

let helper: NetHelper | null = null;
const servers = new Map<number, ReturnType<typeof Bun.serve>>();

self.onmessage = (event: MessageEvent<Init | NetRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    helper = new NetHelper(msg.ring, { listening: serve, stopped: unserve });
    return;
  }
  helper?.handle(msg);
};

function serve(port: number): void {
  try {
    servers.set(port, Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => forward(port, req) }));
    if (process.stderr.isTTY) process.stderr.write(`[preview] http://127.0.0.1:${port}/\n`);
  } catch (err) {
    process.stderr.write(`[preview] port ${port}: ${String(err)}\n`);
  }
}

function unserve(port: number): void {
  servers.get(port)?.stop(true);
  servers.delete(port);
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

async function forward(port: number, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(await req.arrayBuffer());
  const request = { method: req.method, target: url.pathname + url.search, headers: Array.from(req.headers), body };
  return new Promise((resolve) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let answered = false;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const sink: PreviewSink = {
      head: ({ status, statusText, headers }) => {
        answered = true;
        const kept = headers.filter(([name]) => !DROP.has(name));
        resolve(new Response(NULL_BODY.has(status) ? null : stream, { status, statusText, headers: kept }));
      },
      data: (chunk) => controller?.enqueue(chunk),
      end: () => controller?.close(),
      error: (message) => {
        if (answered) controller?.error(new Error(message));
        else resolve(new Response(`bun.wasm server error: ${message}\n`, { status: 502 }));
      },
    };
    if (!helper?.request(port, request, sink)) resolve(new Response("no server\n", { status: 502 }));
  });
}
