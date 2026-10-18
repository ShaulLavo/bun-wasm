import type { APIRequest, APIRequestContext, APIResponse } from "playwright";
import type { IncomingHttpHeaders } from "node:http";

interface RequestOptions {
  method?: string;
  headers: IncomingHttpHeaders;
  data?: Buffer;
}
interface UpstreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
interface PendingRequest {
  response: Promise<UpstreamResponse>;
  cancel(): void;
}
const hopHeaders: ReadonlySet<string> = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "proxy-connection", "upgrade", "http2-settings"]);

function requestHeaders(source: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || hopHeaders.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function responseHeaders(response: APIResponse): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const { name, value } of response.headersArray()) {
    const key = name.toLowerCase();
    if (hopHeaders.has(key) || key === "content-encoding") continue;
    const previous = headers[key];
    headers[key] = previous === undefined ? value : Array.isArray(previous) ? previous.concat(value) : [previous, value];
  }
  return headers;
}

export class Upstream {
  private readonly factory: APIRequest;
  private readonly lifetime = new AbortController();
  private readonly active = new Map<symbol, { path: string; request: PendingRequest }>();

  constructor(factory: APIRequest) { this.factory = factory; }

  static async create(): Promise<Upstream> {
    const { request } = await import(process.env.PLAYWRIGHT ?? "../node_modules/playwright/index.mjs");
    return new Upstream(request);
  }

  request(target: URL, options: RequestOptions): PendingRequest {
    this.lifetime.signal.throwIfAborted();
    const key = Symbol();
    const canceled = new AbortController();
    const cancel = () => canceled.abort(new Error("Proxy request canceled"));
    const response = this.fetch(target, options, canceled.signal).finally(() => this.active.delete(key));
    const request = { response, cancel };
    this.active.set(key, { path: target.href, request });
    return request;
  }

  snapshot(): unknown {
    return { client: "playwright", pending: Array.from(this.active.values(), entry => entry.path) };
  }

  async close(): Promise<void> {
    this.lifetime.abort(new Error("Proxy closed"));
    const requests = Array.from(this.active.values(), entry => entry.request);
    for (const request of requests) request.cancel();
    await Promise.allSettled(requests.map(request => request.response));
  }

  private async fetch(target: URL, options: RequestOptions, signal: AbortSignal): Promise<UpstreamResponse> {
    const client: APIRequestContext = await this.factory.newContext({ timeout: 180_000 });
    let disposing: Promise<void> | undefined;
    const dispose = () => disposing ??= client.dispose();
    const abort = () => { void dispose().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await client.fetch(target.href, { method: options.method, headers: requestHeaders(options.headers), data: options.data, maxRetries: 0, maxRedirects: 0, failOnStatusCode: false });
      return { statusCode: response.status(), headers: responseHeaders(response), body: await response.body() };
    } finally {
      signal.removeEventListener("abort", abort);
      await dispose();
    }
  }
}
