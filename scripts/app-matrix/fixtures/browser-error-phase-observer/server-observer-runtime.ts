import nodeModule from "module";
import { AsyncLocalStorage } from "async_hooks";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { observeCall, replaceMethod, shadowMethod, type CallEvent } from "./server-observer-call";
import { markHookInstalled, markRegistered, record, setRegistration } from "./server-observer-state";

type RequestContext = { probe: string; requestId: number; request: IncomingMessage; response: ServerResponse };
type CacheProvider = { cache?: Record<string, { exports: unknown } | undefined> };
type CachedModule = { path: string; exports: object };
const contexts = new WeakMap<object, RequestContext>();
const scope = new AsyncLocalStorage<RequestContext>();
let sequence = 0;
let callSequence = 0;
let installed = false;

function property(value: unknown, name: string): unknown {
  return value !== null && (typeof value === "object" || typeof value === "function") ? Reflect.get(value, name) : undefined;
}

function metadataProperty(value: unknown, name: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return; }
}

function metadataScalar(value: unknown, name: string): string | boolean | undefined {
  const field = metadataProperty(value, name);
  return typeof field === "string" || typeof field === "boolean" ? field : undefined;
}

function contextForRequest(value: unknown): RequestContext | undefined {
  if (!value || typeof value !== "object") return;
  const direct = contexts.get(value);
  if (direct) return direct;
  const original = metadataProperty(value, "originalRequest");
  if (original && typeof original === "object") return contexts.get(original);
}

function identify(args: unknown[]): RequestContext | undefined {
  return contextForRequest(args[0]) ?? contextForRequest(metadataProperty(args[0], "req")) ?? scope.getStore();
}

function phaseRecord(context: RequestContext | undefined, stage: string, details: Record<string, unknown>): void {
  record(context?.probe ?? "observer", stage, { correlation: context ? "request-object-async-context" : "missing", requestId: context?.requestId, ...details });
}

function callDetails(args: unknown[]): Record<string, unknown> {
  const first = args[0];
  return { page: metadataScalar(first, "page"), url: metadataScalar(first, "url"), pathname: metadataScalar(first, "pathname"), shouldEnsure: metadataScalar(first, "shouldEnsure") };
}

function observePhase(original: Function, name: string, coverage: string): Function {
  return new Proxy(original, {
    apply(target, receiver, args) {
      const context = identify(args);
      const callId = ++callSequence;
      const details = { callId, coverage, ...callDetails(args) };
      const observe = (event: CallEvent) => phaseRecord(context, `${name}:${event.stage}`, { ...details, valueType: event.value === null ? "null" : typeof event.value });
      const wrapped = observeCall(target, observe);
      if (!context) return Reflect.apply(wrapped, receiver, args);
      return scope.run(context, () => Reflect.apply(wrapped, receiver, args));
    },
  });
}

function patch(prototype: object, method: string, name: string, coverage: string): boolean {
  const success = replaceMethod(prototype, method, original => observePhase(original, name, coverage));
  record("observer", success ? "hook-installed" : "hook-missing", { target: name, method, coverage });
  if (success) markHookInstalled(name);
  return success;
}

function cachedModule(provider: CacheProvider, suffix: string): CachedModule {
  const path = Object.keys(provider.cache ?? {}).find(candidate => candidate.endsWith(suffix));
  const exports = path ? provider.cache?.[path]?.exports : undefined;
  if (!path || !exports || typeof exports !== "object") throw new Error(`Required cached module unavailable: ${suffix}`);
  return { path, exports };
}

function prototypeOf(module: CachedModule): object {
  const prototype = property(property(module.exports, "default"), "prototype");
  if (!prototype || typeof prototype !== "object") throw new Error(`Cached class unavailable: ${module.path}`);
  return prototype;
}

function installNextObserver(): void {
  const { createRequire } = nodeModule;
  const servingRequire = createRequire(process.cwd() + "/__serving_observer__.cjs");
  const provider: CacheProvider = servingRequire;
  if (!provider.cache) throw new Error("Public createRequire did not expose a CommonJS cache");
  const base = cachedModule(provider, "/next/dist/server/base-server.js");
  const next = cachedModule(provider, "/next/dist/server/next-server.js");
  const dev = cachedModule(provider, "/next/dist/server/dev/next-dev-server.js");
  setRegistration({ moduleCacheAccess: true, provider: "module.createRequire", modules: [
    { label: "base-server", path: base.path, defaultConstructor: String(property(property(base.exports, "default"), "name")) },
    { label: "next-server", path: next.path, defaultConstructor: String(property(property(next.exports, "default"), "name")) },
    { label: "next-dev-server", path: dev.path, defaultConstructor: String(property(property(dev.exports, "default"), "name")) },
  ] });
  const basePrototype = prototypeOf(base);
  const nextPrototype = prototypeOf(next);
  const devPrototype = prototypeOf(dev);
  const results = [
    patch(basePrototype, "handleRequest", "handle-request-base", "request-object-context"),
    patch(devPrototype, "handleRequest", "handle-request-dev", "request-object-context"),
    patch(devPrototype, "ensurePage", "ensure-page", "compile-interval"),
    patch(devPrototype, "findPageComponents", "find-page-components-dev", "coarse-compilation-lookup-load"),
    patch(nextPrototype, "findPageComponents", "find-page-components-parent", "coarse-lookup-load"),
    patch(basePrototype, "renderErrorToResponseImpl", "error-render-base", "error-render"),
    patch(nextPrototype, "renderErrorToResponseImpl", "error-render", "error-render"),
    patch(basePrototype, "renderToResponseWithComponents", "render-components", "render-components"),
    patch(nextPrototype, "sendRenderResult", "send-render-result", "class-send-render-result"),
  ];
  if (results.some(value => !value)) throw new Error("Required class method is unavailable");
  record("observer", "hooks-ready", { identity: "request-object-async-context", directLoadComponentsTiming: false });
}

function receive(request: unknown, response: unknown): RequestContext | undefined {
  if (!(request instanceof IncomingMessage) || !(response instanceof ServerResponse)) return;
  const probe = request.headers["x-bun-writer-probe"] ?? request.headers["x-bun-error-phase-probe"];
  if (typeof probe !== "string" || probe.length > 80) return;
  const context: RequestContext = { probe, requestId: ++sequence, request, response };
  contexts.set(request, context);
  contexts.set(response, context);
  phaseRecord(context, "request-event", { requestIsIncomingMessage: true, responseIsServerResponse: true });
  phaseRecord(context, "request", { method: request.method, url: request.url });
  response.once("finish", () => phaseRecord(context, "finish", { status: response.statusCode }));
  response.once("close", () => phaseRecord(context, "response-close", { status: response.statusCode }));
  request.socket.once("close", (hadError: boolean) => phaseRecord(context, "socket-close", { hadError }));
  return context;
}

function emitRequest(target: Function, receiver: unknown, args: unknown[]): unknown {
  const context = args[0] === "request" ? receive(args[1], args[2]) : undefined;
  if (!context) return Reflect.apply(target, receiver, args);
  return scope.run(context, () => Reflect.apply(target, receiver, args));
}

function writer(original: Function, name: string): Function {
  return new Proxy(original, {
    apply(target, receiver, args) {
      const context = contextForRequest(receiver);
      if (!context) return Reflect.apply(target, receiver, args);
      const observe = (event: CallEvent) => phaseRecord(context, `${name}:${event.stage}`, { status: context.response.statusCode, headersSent: context.response.headersSent });
      return Reflect.apply(observeCall(target, observe), receiver, args);
    },
  });
}

function installHttpObserver(): void {
  installHttpHook(Server.prototype, "emit", "http-request", original => new Proxy(original, { apply: emitRequest }));
  for (const name of ["writeHead", "flushHeaders", "write", "end"]) {
    installHttpHook(ServerResponse.prototype, name, `http-${name}`, original => writer(original, name));
  }
}

function installHttpHook(prototype: object, method: string, name: string, wrap: (original: Function) => Function): void {
  if (!shadowMethod(prototype, method, wrap)) throw new Error(`Required HTTP method is unavailable: ${method}`);
  markHookInstalled(name);
}

export async function register(): Promise<void> {
  if (installed) return;
  installed = true;
  markRegistered();
  try { installHttpObserver(); installNextObserver(); }
  catch (error) { record("observer", "hook-install-error", { error: String(error) }); }
}
