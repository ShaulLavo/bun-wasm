import assert from "node:assert/strict";
import { instrumentWorker, instrumentRouter, instrumentConsumerPreview, sha } from "./provider";

export function once(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length, 2, `unique anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}
export function sandbox(source: string, prelude: string) {
  let text = once(source, "    const sharedObjects = installBunSharedObjects(runtime);", `    __state.runtimes.set(this.previews, runtime);
    __trace("runtime-router", { runtime: __id(runtime), router: __id(this.previews), sandbox: __id(this), template: this.template });
    const sharedObjects = installBunSharedObjects(runtime);`);
  text = once(text, "    listening: (port, helper) => {", `    listening: (port, helper) => {
      __trace("sandbox-listening", { sandbox: __id(this), router: __id(this.previews), helper: __id(helper), port, listenerRevision: this.listenerRevision });`);
  text = once(text, "    stopped: (port, helper) => {", `    stopped: (port, helper) => {
      __trace("sandbox-stopped", { sandbox: __id(this), router: __id(this.previews), helper: __id(helper), port, current: __id(this.server?.helper) });`);
  return prelude + text;
}
// The provider's realm-local identity state is shared by the additional consumer taps.
export function providerPrelude(router: string) {
  const observed = instrumentRouter(router);
  const offset = observed.indexOf(router.slice(0, 80));
  assert(offset > 0);
  return observed.slice(0, offset);
}
export function helper(source: string, prelude: string) {
  assert.equal(sha(source), "a9278bfb82ad0f77ca0aca9825533da228ca139b9c15ce23353f78de1f5e4363", "exact original .130 helper");
  let text = once(source, "    return this.requestConnection(port, req, sink) !== null;", `    __trace("helper-request", { helper: __id(this), port, request: __id(req), target: req.target, disposed: this.disposed, listeners: Array.from(this.listeners), sharedListeners: Array.from(this.sharedListeners), namespace: __id(this.namespace), namespaceListeners: Array.from(Reflect.get(this.namespace, "listeners"), ([port, value]) => ({ port, owner: __id(value.owner), handle: value.handle, local: value.local })), namespaceFailure: String(Reflect.get(this.namespace, "failure") ?? "") });
    const __connection = this.requestConnection(port, req, sink);
    __trace("helper-request-return", { helper: __id(this), port, target: req.target, connection: __id(__connection), accepted: __connection !== null, disposed: this.disposed });
    return __connection !== null;`);
  text = once(text, "    if (!connection) return null;\n    connection.write(request);", `    __trace("helper-connection", { helper: __id(this), port, target: req.target, connection: __id(connection), disposed: this.disposed });
    if (!connection) return null;
    connection.write(request);`);
  text = once(text, "    if (!this.live()) return null;", `    __trace("helper-connect", { helper: __id(this), port, host, listener, disposed: this.disposed, shared: listener === undefined ? null : this.sharedListeners.has(listener), namespace: __id(this.namespace) });
    if (!this.live()) return null;`);
  text = once(text, '    if (typeof connected === "number") return null;', `    __trace("helper-namespace-result", { helper: __id(this), port, host, namespace: __id(this.namespace), result: typeof connected === "number" ? connected : "connection" });
    if (typeof connected === "number") return null;`);
  text = once(text, "  dispose(): void {\n    if (this.disposed) return;", `  dispose(): void {
    __trace("helper-dispose", { helper: __id(this), disposed: this.disposed, listeners: Array.from(this.listeners), namespace: __id(this.namespace) });
    if (this.disposed) return;`);
  text = once(text, "    const bind = this.namespace.address(port);", `    const bind = this.namespace.address(port);
    __trace("helper-address", { helper: __id(this), port, bind: bind ?? null });`);
  text = once(text, "    if (!target) return null;", `    __trace("helper-target", { helper: __id(this), port, target: target ?? null });
    if (!target) return null;`);
  text = once(text, "    if (!address) return null;", `    __trace("helper-accepted-address", { helper: __id(this), port, address: address ?? null });
    if (!address) return null;`);
  text = once(text, "    this.ring = new RingWriter(sab);", `    this.ring = new RingWriter(sab);
    __trace("helper-created", { helper: __id(this), namespace: __id(this.namespace), disposed: this.disposed });`);
  return prelude + text;
}
export function worker(source: string) {
  let text = instrumentWorker(source);
  text = once(text, '__claim("claim-reply", { reply: msg.type });', '__claim("claim-reply", { reply: msg.type, payload: msg, acceptedReceipt: msg.type === "accepted" });');
  text = once(text, '__trace("forward", { ask: __id(ask), target, port, url: request.url, method: request.method });', '__trace("forward", { ask: __id(ask), target, port, url: request.url, method: request.method, payload: ask });');
  return text;
}
export { instrumentRouter, instrumentConsumerPreview, sha };

export function networkProjection(source: string, prelude: string) {
  assert.equal(sha(source), "adc3b3c9055f952994fc82b6257faab20a568a57a096f8edc22ff9bbdecd04db", "exact original .130 helper projection");
  let text = once(source, "      helpers.set(helper, capability);", `      __trace("helper-projection", { helper: __id(helper), capability: __id(capability), namespace: __id(namespace) });
      helpers.set(helper, capability);`);
  text = once(text, "    request(port, request, sink) {", `    request(port, request, sink) {
      __trace("projection-request", { capability: __id(this), helper: __id(helper), port, target: request.target, closed });`);
  text = once(text, "    dispose() {\n      if (closed) return;", `    dispose() {
      __trace("projection-dispose", { capability: __id(this), helper: __id(helper), closed });
      if (closed) return;`);
  return prelude + text;
}
