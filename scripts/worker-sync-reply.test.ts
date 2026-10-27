import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker, MessagePort as NativeMessagePort } from "node:worker_threads";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";

// A reply posted before Atomics.notify must be readable by the woken caller's single
// receiveMessageOnPort, as esbuild's transformSync expects, even when the broker is idle.
for (const noLanes of [false, true]) test(`a blocked caller reads a reply posted before the notify while the broker is held, lanes=${!noLanes}`, async () => {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const broker = createSharedObjectBroker();
  const workers: Worker[] = [], ports: NativeMessagePort[] = [];
  const result = Promise.withResolvers<{ kind: string; results: unknown[]; error?: string }>();
  const deadline = setTimeout(() => result.reject(new Error("Synchronous reply fixture exceeded 5 seconds")), 5000);
  try {
    const leases = { caller: broker.register(), service: broker.register() };
    const fixture = new URL("./fixtures/shared-objects/sync-reply-worker.ts", import.meta.url);
    const caller = new Worker(fixture, { workerData: { owner: leases.caller.id, role: "caller", gate: gate.buffer, noLanes } });
    const service = new Worker(fixture, { workerData: { owner: leases.service.id, role: "service", gate: gate.buffer, noLanes } });
    workers.push(caller, service);
    function message(lease: typeof leases.caller, value: Record<string, unknown>) {
      if (value.type === "bun-shared-connect") {
        if (value.owner !== lease.id || !(value.port instanceof NativeMessagePort)) throw new Error("Invalid native shared attachment");
        ports.push(value.port); lease.attach(value.port); return;
      }
      if (value.kind === "gate") {
        if (typeof value.round !== "number") throw new Error("Invalid gate round");
        Atomics.store(gate, 0, value.round); Atomics.notify(gate, 0);
        if (Atomics.load(gate, 1) < value.round && Atomics.wait(gate, 1, value.round - 1, 2000) === "timed-out") throw new Error("Caller failed to perform receive while broker held");
        return;
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
    const actual = await result.promise;
    if (noLanes) { expect(actual.results).toEqual([]); expect(actual.error).toContain("Cannot destructure property"); }
    else expect(actual).toEqual({ kind: "result", results: ["first", "second", "third"] });
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
