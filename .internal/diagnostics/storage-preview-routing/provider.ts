import { createHash } from "node:crypto";

const prelude = `
const __state = globalThis.__routingState ??= { ids: new WeakMap<object, number>(), nextId: 0, sequence: 0, runtimes: new WeakMap<object, object>() };
function __id(value: object | undefined) {
  if (!value) return null;
  let id = __state.ids.get(value);
  if (!id) { id = ++__state.nextId; __state.ids.set(value, id); }
  return id;
}
function __trace(kind: string, fields: object) {
  try {
    const sink = globalThis.__routingTrace;
    if (sink) sink({ kind, sequence: ++__state.sequence, mono: performance.now(), wall: Date.now(), ...fields });
  } catch {}
}
`;

function insert(source: string, anchor: string, replacement: string) {
  if (source.split(anchor).length !== 2) throw new Error(`Non-unique source anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}

export function instrumentWorker(source: string) {
  if (sha(source) !== "9c2ff1deaef93b9a5935b3398439723058b257992af108191203c7d3bc8481a1") throw new Error("Wrong Waffle worker source");
  let result = source;
  result = insert(result, "      const channel = createChannel();\n      let body:", `      const channel = createChannel();
      const __claim = (kind: string, extra: object = {}) => __trace(kind, {
        ask: __id(ask), target: ask.target, port: ask.port, clientId: client.id ?? null,
        clientURL: client.url, channel: __id(channel.port1), ...extra,
      });
      __claim("claim-open");
      let body:`);
  result = insert(result, "        finished = true;\n        clearTimeout(timer);", "        __claim(\"claim-close\");\n        finished = true;\n        clearTimeout(timer);");
  result = insert(result, "      const timer = setTimeout(() => {\n        close();", "      const timer = setTimeout(() => {\n        __claim(\"claim-timeout\");\n        close();");
  result = insert(result, "        const msg = event.data;\n        switch", "        const msg = event.data;\n        __claim(\"claim-reply\", { reply: msg.type });\n        switch");
  result = insert(result, "        client.postMessage(ask, [channel.port2]);", "        __claim(\"claim-post\", { transferredPort: __id(channel.port2) });\n        client.postMessage(ask, [channel.port2]);\n        __claim(\"claim-post-return\");");
  result = insert(result, "      } catch {\n        close();\n        channel.port2.close();", "      } catch {\n        __claim(\"claim-post-failure\");\n        close();\n        channel.port2.close();");
  result = insert(result, "    const windows = await options.clients.matchAll({ type: \"window\", includeUncontrolled: true });\n    for (const client of windows) {\n      if (isPreview(client)) continue;", `    __trace("forward", { ask: __id(ask), target, port, url: request.url, method: request.method });
    __trace("forward-join", { request: __id(request), ask: __id(ask), target, port });
    const windows = await options.clients.matchAll({ type: "window", includeUncontrolled: true });
    __trace("discovery", { ask: __id(ask), target, clients: windows.map(client => ({ id: client.id ?? null, url: client.url })) });
    for (const client of windows) {
      __trace("candidate", { ask: __id(ask), target, clientId: client.id ?? null, clientURL: client.url });
      if (isPreview(client)) { __trace("candidate-skipped-preview", { ask: __id(ask), target, clientId: client.id ?? null }); continue; }`);
  result = insert(result, "    return (\n      options.unavailableResponse?.(port)", "    __trace(\"unavailable\", { ask: __id(ask), target, port });\n    return (\n      options.unavailableResponse?.(port)");
  result = insert(result, "      const url = new URL(request.url);", "      __trace(\"sw-fetch\", { request: __id(request), url: request.url, clientId });\n      const url = new URL(request.url);");
  return prelude + result;
}

export function instrumentRouter(source: string) {
  if (sha(source) !== "a5522ece8cc7aaf740089285e1a79b3b25f5b775e09fdbaa1cdb5422b53d6fae") throw new Error("Wrong Waffle router source");
  let result = source;
  result = insert(result, "    if (this.servers.get(port) === server) return;", "    __trace(\"register\", { router: __id(this), port, server: __id(server), current: __id(this.servers.get(port)) });\n    if (this.servers.get(port) === server) return;");
  result = insert(result, "    if (this.servers.get(port) !== server) return;", "    __trace(\"unregister\", { router: __id(this), port, server: __id(server), current: __id(this.servers.get(port)) });\n    if (this.servers.get(port) !== server) return;");
  result = insert(result, "    const reply = event.ports[0];", "    const reply = event.ports[0];\n    __trace(\"page-receive\", { router: __id(this), target: ask?.target, port: ask?.port, replyPort: __id(reply), current: __id(this.servers.get(ask?.port)) });");
  result = insert(result, "    const send = (msg: PreviewReply, transfer: Transferable[] = []) =>\n      reply.postMessage(msg, transfer);", `    const send = (msg: PreviewReply, transfer: Transferable[] = []) => {
      __trace("page-send", { router: __id(this), target: ask.target, port: ask.port, replyPort: __id(reply), reply: msg.type });
      return reply.postMessage(msg, transfer);
    };`);
  result = insert(result, "    const accepted = this.servers.get(ask.port)?.request", "    __trace(\"request-dispatch\", { router: __id(this), target: ask.target, port: ask.port, current: __id(this.servers.get(ask.port)) });\n    const accepted = this.servers.get(ask.port)?.request");
  result = insert(result, "    // A transport may finish synchronously;", "    __trace(\"request-return\", { router: __id(this), target: ask.target, port: ask.port, accepted: accepted ?? null, current: __id(this.servers.get(ask.port)) });\n    // A transport may finish synchronously;");
  return prelude + result;
}

export function sha(source: string | Uint8Array) {
  return createHash("sha256").update(source).digest("hex");
}

export function instrumentConsumerPreview(source: string) {
  if (sha(source) !== "b569f4808ebf5d65ffa4663e18da419599fbed0d7797a345d423865dee8352ad") throw new Error("Wrong consumer Previews source");
  const result = insert(source, "    container.addEventListener(\"message\", event => this.onMessage(event));", `    container.addEventListener("message", event => {
      __trace("container-receive", { router: __id(this), runtime: __id(__state.runtimes.get(this)), target: event.data?.target, port: event.data?.port, replyPort: __id(event.ports[0]), sourceWorker: __id(event.source), sourceURL: event.source?.scriptURL ?? null });
      return this.onMessage(event);
    });`);
  return prelude + result;
}

export function instrumentConsumerPlayground(source: string) {
  if (sha(source) !== "0a278bfa30b33eb1aea3aa3bdc8c583ed17d282ea54d52e7c2f18578e3b96424") throw new Error("Wrong consumer playground source");
  const result = insert(source, "    const term = this.term = createTerminal();", `    __state.runtimes.set(previews, runtime);
    __trace("runtime-router", { runtime: __id(runtime), router: __id(previews), playground: __id(this) });
    const term = this.term = createTerminal();`);
  return prelude + result;
}
