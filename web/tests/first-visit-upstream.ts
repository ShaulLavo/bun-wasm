import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { connect as tcpConnect, type TcpSocketConnectOpts } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Readable } from "node:stream";

export interface UpstreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}
interface RequestOptions {
  method?: string;
  headers: OutgoingHttpHeaders;
  signal?: AbortSignal;
  autoSelectFamilyAttemptTimeout?: number;
}
interface UpstreamRequest {
  writable: ClientRequest | ClientHttp2Stream;
  response: Promise<UpstreamResponse>;
}
type ResponseSink = Pick<ReturnType<typeof Promise.withResolvers<UpstreamResponse>>, "resolve" | "reject">;
const hopHeaders: ReadonlySet<string> = new Set(["connection", "host", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "http2-settings"]);

function endToEnd(headers: OutgoingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(":") || hopHeaders.has(name) || value === undefined) continue;
    if (name === "te" && value !== "trailers") continue;
    result[name] = Array.isArray(value) ? value : String(value);
  }
  return result;
}

export class Upstream {
  private session?: ClientHttp2Session;
  private failure?: Error;
  private readonly active = new Set<ClientHttp2Stream>();
  private readonly origin: URL;
  private readonly protocol: "http1" | "http2";

  constructor(origin: URL, protocol: "http1" | "http2") {
    this.origin = origin;
    this.protocol = protocol;
  }

  request(target: URL, options: RequestOptions): UpstreamRequest {
    if (this.failure) throw this.failure;
    const response = Promise.withResolvers<UpstreamResponse>();
    const writable = this.protocol === "http1"
      ? this.http1(target, options, response)
      : this.http2(target, options, response);
    writable.once("error", error => response.reject(this.failure ?? error));
    writable.once("close", () => response.reject(this.failure ?? new Error("Upstream connection closed before response")));
    return { writable, response: response.promise };
  }

  close(): void {
    this.session?.destroy();
  }

  private http2(target: URL, options: RequestOptions, response: ResponseSink): ClientHttp2Stream {
    const session = this.session ??= this.open(options.autoSelectFamilyAttemptTimeout);
    const stream = session.request({ ...endToEnd(options.headers), ":method": options.method ?? "GET", ":path": target.pathname + target.search, ":authority": target.host }, { endStream: false, signal: options.signal });
    this.active.add(stream);
    stream.once("close", () => this.active.delete(stream));
    stream.once("response", headers => {
      const statusCode = headers[":status"];
      if (typeof statusCode !== "number") {
        stream.destroy(new Error("Upstream HTTP/2 response has no status"));
        return;
      }
      response.resolve({ statusCode, headers: endToEnd(headers), body: stream });
    });
    return stream;
  }

  private open(autoSelectFamilyAttemptTimeout = 2_000): ClientHttp2Session {
    const secure = this.origin.protocol === "https:";
    const socketOptions: TcpSocketConnectOpts = { host: this.origin.hostname, port: Number(this.origin.port || (secure ? 443 : 80)), autoSelectFamilyAttemptTimeout };
    const session = connect(this.origin.origin, {
      settings: { enablePush: false },
      createConnection: () => secure
        ? tlsConnect({ ...socketOptions, servername: this.origin.hostname, ALPNProtocols: ["h2"] })
        : tcpConnect(socketOptions),
    });
    session.on("error", error => {
      this.failure = error;
      for (const stream of this.active) stream.destroy(error);
    });
    return session;
  }

  private http1(target: URL, options: RequestOptions, response: ResponseSink): ClientRequest {
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const pending: ClientRequest = request(target, options, received => {
      if (typeof received.statusCode !== "number") {
        pending.destroy(new Error("Upstream HTTP response has no status"));
        return;
      }
      response.resolve({ statusCode: received.statusCode, headers: received.headers, body: received });
    });
    return pending;
  }
}
