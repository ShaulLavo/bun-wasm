import type { NetHelper, PreviewSink } from "../src/net/helper";

export function createCliPreview(port: number, helper: Pick<NetHelper, "request">) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => forward(helper, port, request) });
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

async function forward(helper: Pick<NetHelper, "request">, port: number, req: Request): Promise<Response> {
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
    if (!helper.request(port, request, sink)) resolve(new Response("no server\n", { status: 502 }));
  });
}
