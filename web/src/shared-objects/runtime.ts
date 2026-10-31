import type { ProcessRuntime } from "../../../src/process-runtime.js";
import { createSharedObjectBroker } from "./broker.ts";
import { sharedError } from "./protocol.ts";

const NativeMessagePort = globalThis.MessagePort;
const installations = new WeakMap<ProcessRuntime, SharedObjectRuntime>();
export interface SharedObjectRoute {
  readonly owner: string;
  accept(message: unknown): boolean;
  close(): void;
}
export interface SharedObjectRuntime {
  open(): SharedObjectRoute;
  close(): void;
  inspect(): { clients: number; objects: number; waiting: number };
  inspectTransfers(): { pins: number; attaching: number };
}

/** Internal host installation, deliberately separate from registering the public Bun adapter. */
export function installRuntimeSharedObjects(runtime: ProcessRuntime): SharedObjectRuntime {
  if (runtime.disposed) throw sharedError("Runtime is disposed");
  if (installations.has(runtime)) throw sharedError("Shared-object runtime is already installed");
  const broker = createSharedObjectBroker();
  const routes = new Set<SharedObjectRoute>();
  let closed = false;
  function open(): SharedObjectRoute {
    if (closed || runtime.disposed) throw sharedError("Shared-object runtime is closed");
    const lease = broker.register();
    let released = false, attached = false;
    function accept(message: unknown) {
      if (!message || typeof message !== "object" || !("type" in message) || message.type !== "bun-shared-connect") return false;
      if (!("port" in message) || !NativeMessagePort || !(message.port instanceof NativeMessagePort)) { closeRoute(); throw sharedError("Invalid shared-object native port"); }
      const port = message.port;
      if (released || runtime.disposed) { port.close(); closeRoute(); return true; }
      if (!("owner" in message) || message.owner !== lease.id || attached) { port.close(); closeRoute(); throw sharedError("Invalid shared-object route attachment"); }
      try { lease.attach(port); attached = true; }
      catch (error) { port.close(); closeRoute(); throw error; }
      return true;
    }
    function closeRoute() {
      if (released) return;
      released = true;
      lease.close(); routes.delete(route);
      if (runtime.disposed && !routes.size) close();
    }
    const route = { owner: lease.id, accept, close: closeRoute };
    routes.add(route);
    return route;
  }
  function close() {
    if (closed) return;
    closed = true;
    installations.delete(runtime);
    for (const route of Array.from(routes)) route.close();
    broker.dispose();
  }
  const installation = { open, close, inspect: broker.inspect, inspectTransfers: broker.inspectTransfers };
  installations.set(runtime, installation);
  return installation;
}

export function runtimeSharedObjectRoute(runtime: ProcessRuntime): SharedObjectRoute | undefined {
  return installations.get(runtime)?.open();
}
