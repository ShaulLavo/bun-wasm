import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker, MessagePort as NativeMessagePort } from "node:worker_threads";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";

// A reply posted before Atomics.notify must be readable by the woken caller's single
// receiveMessageOnPort, as esbuild's transformSync expects, even when the broker is idle.
test("a blocked caller reads a routed reply posted before the notify", async () => {
  const broker = createSharedObjectBroker();
  const workers: Worker[] = [], ports: NativeMessagePort[] = [];
  const result = Promise.withResolvers<{ kind: string; results: unknown[]; error?: string }>();
  const deadline = setTimeout(() => result.reject(new Error("Synchronous reply fixture exceeded 5 seconds")), 5000);
  try {
    const leases = { caller: broker.register(), service: broker.register() };
    const fixture = new URL("./fixtures/shared-objects/sync-reply-worker.ts", import.meta.url);
    const caller = new Worker(fixture, { workerData: { owner: leases.caller.id, role: "caller" } });
    const service = new Worker(fixture, { workerData: { owner: leases.service.id, role: "service" } });
    workers.push(caller, service);
    function message(lease: typeof leases.caller, value: Record<string, unknown>) {
      if (value.type === "bun-shared-connect") {
        if (value.owner !== lease.id || !(value.port instanceof NativeMessagePort)) throw new Error("Invalid native shared attachment");
        ports.push(value.port); lease.attach(value.port); return;
      }
      if (value.kind === "initial") { service.postMessage({ kind: "restore", graph: value.graph }); return; }
      if (value.kind === "ready") { caller.postMessage({ kind: "run" }); return; }
      if (value.kind === "result") { result.resolve(value as { kind: string; results: unknown[]; error?: string }); return; }
      if (value.kind !== "cleanup") throw new Error("Unknown synchronous reply fixture response");
    }
    for (const [worker, lease] of [[caller, leases.caller], [service, leases.service]] as const) {
      worker.on("message", value => { try { message(lease, value); } catch (error) { result.reject(error); } });
      worker.on("error", result.reject);
      worker.once("exit", () => lease.close());
    }
    expect(await result.promise).toEqual({ kind: "result", results: ["first", "second", "third"] });
    const exits = workers.map(worker => once(worker, "exit"));
    for (const worker of workers) worker.postMessage({ kind: "stop" });
    expect(await Promise.all(exits)).toEqual([[0], [0]]);
    expect(broker.inspectRoutes()).toEqual({ endpoints: 0, pending: 0, registrations: 0 });
  } finally {
    clearTimeout(deadline);
    await Promise.all(workers.map(worker => worker.terminate()));
    for (const port of ports) port.close();
    broker.dispose();
  }
}, 7000);
