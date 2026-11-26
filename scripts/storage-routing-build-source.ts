import { createHash } from "node:crypto";

const prelude = `
const __state = Reflect.get(globalThis, "__routingState") ?? { ids: new WeakMap<object, number>(), nextId: 0, sequence: 0, runtimes: new WeakMap<object, number>() };
Reflect.set(globalThis, "__routingState", __state);
function __id(value: object | undefined) {
  if (!value) return null;
  let id = __state.ids.get(value);
  if (!id) { id = ++__state.nextId; __state.ids.set(value, id); }
  return id;
}
function __error(error: unknown): string {
  try { return String(error); } catch { return "Unprintable thrown value"; }
}
function __trace(kind: string, fields: object) {
  try {
    const sink = Reflect.get(globalThis, "__routingTrace");
    if (sink) sink({ kind, sequence: ++__state.sequence, mono: performance.now(), wall: Date.now(), ...fields });
  } catch {}
}
`;

function insert(source: string, anchor: string, replacement: string) {
  if (source.split(anchor).length !== 2) throw new Error(`Non-unique source anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}

export function instrumentWorker(source: string) {
  verifySource("browser/service-worker.ts", source);
  return applyEdits(source, [
    ["      const channel = createChannel();\n      let body:", `      const channel = createChannel();
      let __bodyChunks = 0;
      const __claimFields = {
        ask: __id(ask), target: ask.target, port: ask.port, clientId: Reflect.get(client, "id") ?? null,
        clientURL: client.url, channel: __id(channel.port1),
      };
      const __claim = (kind: string, extra: object = {}) => __trace(kind, { ...__claimFields, ...extra });
      __claim("claim-open");
      let body:`],
    ["        finished = true;\n        clearTimeout(timer);", "        __claim(\"claim-close\");\n        finished = true;\n        clearTimeout(timer);"],
    ["      const timer = setTimeout(() => {\n        close();", "      const timer = setTimeout(() => {\n        __claim(\"claim-timeout\");\n        close();"],
    ["        const msg = event.data;\n        switch", `        const msg = event.data;
        if (msg.type === "data") __bodyChunks++;
        if (msg.type !== "data" || __bodyChunks === 1) __claim("claim-reply", { reply: msg.type, status: msg.type === "head" ? msg.status : null, error: msg.type === "error" ? msg.message : null, bodyChunks: __bodyChunks });
        switch`],
    ["        client.postMessage(ask, [channel.port2]);", "        __claim(\"claim-post\", { transferredPort: __id(channel.port2) });\n        client.postMessage(ask, [channel.port2]);\n        __claim(\"claim-post-return\");"],
    ["      } catch {\n        close();\n        channel.port2.close();", "      } catch {\n        __claim(\"claim-post-failure\");\n        close();\n        channel.port2.close();"],
    ["    const windows = await options.clients.matchAll({ type: \"window\", includeUncontrolled: true });\n    for (const client of windows) {\n      if (isPreview(client)) continue;", `    const __requestUrl = String(Reflect.get(request, "__originalUrl") ?? request.url);
    __trace("forward", { ask: __id(ask), target, port, url: __requestUrl, method: request.method });
    __trace("forward-join", { request: __id(request), ask: __id(ask), target, port });
    const windows = await options.clients.matchAll({ type: "window", includeUncontrolled: true });
    __trace("discovery", { ask: __id(ask), target, clients: windows.length });
    for (const client of windows) {
      __trace("candidate", { ask: __id(ask), target, clientId: Reflect.get(client, "id") ?? null, clientURL: client.url });
      if (isPreview(client)) { __trace("candidate-skipped-preview", { ask: __id(ask), target, clientId: Reflect.get(client, "id") ?? null }); continue; }`],
    ["    return (\n      options.unavailableResponse?.(port)", "    __trace(\"unavailable\", { ask: __id(ask), target, port });\n    return (\n      options.unavailableResponse?.(port)"],
    ["      const url = new URL(request.url);", "      __trace(\"sw-fetch\", { request: __id(request), url: String(Reflect.get(request, \"__originalUrl\") ?? request.url), clientId });\n      const url = new URL(request.url);"]
  ]);
}

export function instrumentRouter(source: string) {
  verifySource("browser/preview.ts", source);
  return applyEdits(source, [
    ["    if (this.servers.get(port) === server) return;", "    __trace(\"register\", { router: __id(this), port, server: __id(server), current: __id(this.servers.get(port)) });\n    if (this.servers.get(port) === server) return;"],
    ["    if (this.servers.get(port) !== server) return;", "    __trace(\"unregister\", { router: __id(this), port, server: __id(server), current: __id(this.servers.get(port)) });\n    if (this.servers.get(port) !== server) return;"],
    ["    const reply = event.ports[0];", "    const reply = event.ports[0];\n    __trace(\"page-receive\", { router: __id(this), target: ask?.target, port: ask?.port, replyPort: __id(reply), current: ask ? __id(this.servers.get(ask.port)) : null });"],
    ["    const send = (msg: PreviewReply, transfer: Transferable[] = []) =>\n      reply.postMessage(msg, transfer);", `    let __bodyCalls = 0, __bodyReturns = 0;
    const __replyFields = { router: __id(this), target: ask.target, port: ask.port, replyPort: __id(reply) };
    const __replyTrace = (kind: string, extra: object) => __trace(kind, { ...__replyFields, bodyCalls: __bodyCalls, bodyReturns: __bodyReturns, ...extra });
    const send = (msg: PreviewReply, transfer: Transferable[] = []) => {
      if (msg.type === "data") __bodyCalls++;
      const __report = msg.type !== "data" || __bodyCalls === 1;
      if (__report) __replyTrace("page-send", { reply: msg.type });
      try {
        const result = reply.postMessage(msg, transfer);
        if (msg.type === "data") __bodyReturns++;
        if (__report) __replyTrace("page-send-return", { reply: msg.type });
        return result;
      } catch (error) {
        __replyTrace("page-send-error", { reply: msg.type, error: __error(error) });
        throw error;
      }
    };`],
    ["    const accepted = this.servers.get(ask.port)?.request", "    __trace(\"request-dispatch\", { router: __id(this), target: ask.target, port: ask.port, replyPort: __id(reply), request: __id(request), current: __id(this.servers.get(ask.port)) });\n    const accepted = this.servers.get(ask.port)?.request"],
    ["    // A transport may finish synchronously;", "    __trace(\"request-return\", { router: __id(this), target: ask.target, port: ask.port, accepted: accepted ?? null, current: __id(this.servers.get(ask.port)) });\n    // A transport may finish synchronously;"]
  ]);
}

function sha(source: string) {
  return createHash("sha256").update(source).digest("hex");
}

export function instrumentConsumerPreview(source: string) {
  return applyEdits(source, [
    [
      "  private readonly onContainerMessage = (event: MessageEvent) => {\n    this.onMessage(event as unknown as Parameters<PreviewRouter[\"onMessage\"]>[0]);\n  };",
      `  private readonly onContainerMessage = (event: MessageEvent) => {
    __trace("container-receive", { router: __id(this), runtime: __state.runtimes.get(this) ?? null, target: event.data?.target, port: event.data?.port, replyPort: __id(event.ports[0]), sourceWorker: __id(event.source), sourceURL: event.source && "scriptURL" in event.source ? event.source.scriptURL : null });
    this.onMessage(event as unknown as Parameters<PreviewRouter["onMessage"]>[0]);
  };`,
    ],
    [
      "    const server = this.localServers.get(ask.port);\n    if (!server) {",
      `    const server = this.localServers.get(ask.port);
    __trace("page-receive", { router: __id(this), target: ask?.target, port: ask?.port, replyPort: __id(reply), current: __id(server) });
    if (!server) {
      __trace("request-dispatch", { router: __id(this), target: ask.target, port: ask.port, replyPort: __id(reply), request: null, current: null });`,
    ],
    [
      "    const sendConnect = (msg: PreviewReply, transfer: Transferable[] = []) => {\n      if (finished) return;\n      try { reply.postMessage(msg, transfer); } catch { stopConnect(); }\n    };",
      `    let __bodyCalls = 0, __bodyReturns = 0;
    const __replyFields = { router: __id(this), target: ask.target, port: ask.port, replyPort: __id(reply) };
    const __replyTrace = (kind: string, extra: object) => __trace(kind, { ...__replyFields, bodyCalls: __bodyCalls, bodyReturns: __bodyReturns, ...extra });
    const sendConnect = (msg: PreviewReply, transfer: Transferable[] = []) => {
      if (finished) return;
      if (msg.type === "data") __bodyCalls++;
      const __report = msg.type !== "data" || __bodyCalls === 1;
      if (__report) __replyTrace("page-send", { reply: msg.type });
      try {
        reply.postMessage(msg, transfer);
        if (msg.type === "data") __bodyReturns++;
        if (__report) __replyTrace("page-send-return", { reply: msg.type });
      } catch (error) {
        __replyTrace("page-send-error", { reply: msg.type, error: __error(error) });
        stopConnect();
      }
    };`,
    ],
    [
      "    connection = server.connect(ask.port, {\n      data: (chunk) => { if (!finished) parser.push(chunk); },\n      end: () => { if (!finished) parser.end(); },\n      error: (message) => finishConnect({ type: \"error\", message }),\n    });",
      `    __trace("request-dispatch", { router: __id(this), target: ask.target, port: ask.port, replyPort: __id(reply), request: __id(request), current: __id(server) });
    const __connectSink = {
      data: (chunk: Uint8Array) => { if (!finished) parser.push(chunk); },
      end: () => { if (!finished) parser.end(); },
      error: (message: string) => finishConnect({ type: "error", message }),
    };
    Reflect.set(__connectSink, "__routingRequest", request);
    connection = server.connect(ask.port, __connectSink);
    if (connection) __trace("request-return", { router: __id(this), target: ask.target, port: ask.port, accepted: true, current: __id(server) });`,
    ],
    [
      "    const sendReq = (msg: PreviewReply, transfer: Transferable[] = []) => {\n      if (reqCancelled || reqEnded) return;\n      try { reply.postMessage(msg, transfer); } catch { stopRequest(); }\n    };",
      `    const sendReq = (msg: PreviewReply, transfer: Transferable[] = []) => {
      if (reqCancelled || reqEnded) return;
      if (msg.type === "data") __bodyCalls++;
      const __report = msg.type !== "data" || __bodyCalls === 1;
      if (__report) __replyTrace("page-send", { reply: msg.type });
      try {
        reply.postMessage(msg, transfer);
        if (msg.type === "data") __bodyReturns++;
        if (__report) __replyTrace("page-send-return", { reply: msg.type });
      } catch (error) {
        __replyTrace("page-send-error", { reply: msg.type, error: __error(error) });
        stopRequest();
      }
    };`,
    ],
    [
      "    if (!reqCancelled) {\n      sendReq({ type: accepted ? \"accepted\" : \"none\" });",
      `    __trace("request-return", { router: __id(this), target: ask.target, port: ask.port, accepted, current: __id(server) });
    if (!reqCancelled) {
      sendReq({ type: accepted ? "accepted" : "none" });`,
    ],
  ]);
}

export function instrumentRoutedWorker(source: string): string {
  return prelude + insert(
    source,
    "    const adapter = makeScopedAdapter(parsed.route, parsed.routeKey, parsed.port, signal);",
    `    Reflect.set(forwardedRequest, "__originalUrl", request.url);
    const adapter = makeScopedAdapter(parsed.route, parsed.routeKey, parsed.port, signal);`,
  );
}


const sources: Record<string, string> = {"browser/service-worker.ts": "11141b1fc8b8ffd0d7810d46bfa599e8923c84d6e719a597c70afa72f47ddce2", "browser/preview.ts": "482a5f1678f4ed22f9bf1c932097d4c98388216ad2547b530c1c15e0f5c2bb42", "browser/net/helper.ts": "e64e1a736c40fa916b986cedbb0c87d6b2099312df4402d2a2a90d4cf583cf27", "browser/net/runtime.ts": "269d7b68e9e693bc9d0645740ebabb33fd6412844600cb239424426efc015bfe"};
export function verifySource(path: string, source: string): void {
  if (sources[path] !== sha(source)) throw Error(`Storage routing source differs from the qualified Waffle source: ${path}`);
}

export function instrumentSandbox(source: string): string {
  return prelude + insert(source, "      sharedObjects = installBunSharedObjects(runtime);", `      __state.runtimes.set(this.previews, __id(runtime));
      __trace("runtime-router", { runtime: __id(runtime), router: __id(this.previews), template: this.template });
      sharedObjects = installBunSharedObjects(runtime);`);
}
export function instrumentHelper(source: string): string {
  verifySource("browser/net/helper.ts", source);
  return applyEdits(source, [
    [
      "    if (!signal) return this.requestConnection(port, req, sink) !== null;",
      `    if (!signal) {
      __trace("helper-request", { helper: __id(this), request: __id(req), port, target: req.target });
      try {
        const connection = this.requestConnection(port, req, sink);
        __trace("helper-request-return", { helper: __id(this), request: __id(req), port, target: req.target, accepted: connection !== null });
        return connection !== null;
      } catch (error) {
        __trace("helper-request-error", { helper: __id(this), request: __id(req), port, target: req.target, error: __error(error) });
        throw error;
      }
    }`,
    ],
    [
      "  connect(port: number, sink: ConnectionSink, host?: string): PreviewConnection | null {",
      `  connect(port: number, sink: ConnectionSink, host?: string): PreviewConnection | null {
    const __routingReq = Reflect.get(sink, "__routingRequest") as { target?: string } | undefined;
    if (!__routingReq) return this.__rawConnect(port, sink, host);
    __trace("helper-request", { helper: __id(this), request: __id(__routingReq), port, target: __routingReq.target ?? null });
    try {
      const __conn = this.__rawConnect(port, sink, host);
      __trace("helper-request-return", { helper: __id(this), request: __id(__routingReq), port, target: __routingReq.target ?? null, accepted: __conn !== null });
      return __conn;
    } catch (error) {
      __trace("helper-request-error", { helper: __id(this), request: __id(__routingReq), port, target: __routingReq.target ?? null, error: __error(error) });
      throw error;
    }
  }
  private __rawConnect(port: number, sink: ConnectionSink, host?: string): PreviewConnection | null {`,
    ],
  ]);
}
export function instrumentProjection(source: string): string {
  verifySource("browser/net/runtime.ts", source);
  return prelude + insert(source, "      helpers.set(helper, capability);", `      __trace("helper-projection", { helper: __id(helper), capability: __id(capability), namespace: __id(namespace) });
      helpers.set(helper, capability);`);
}

function applyEdits(source: string, edits: [string, string][]): string {
  for (const [anchor, replacement] of edits) source = insert(source, anchor, replacement);
  return prelude + source;
}
