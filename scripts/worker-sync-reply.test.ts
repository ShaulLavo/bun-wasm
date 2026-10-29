import { expect, test } from "bun:test";
import { Worker, MessagePort as NativeMessagePort } from "node:worker_threads";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";

interface FixtureResult { kind: string; results: unknown[]; error?: string }
type CloseMode = "race" | "failure";

async function runFixture(noLanes: boolean, closeMode?: CloseMode) {
  const gate = new Int32Array(new SharedArrayBuffer(12));
  const broker = createSharedObjectBroker();
  const workers: Worker[] = [], ports: NativeMessagePort[] = [], failures: Error[] = [];
  const result = Promise.withResolvers<FixtureResult>(), timeout = Promise.withResolvers<never>();
  const deadline = setTimeout(() => timeout.reject(new Error("Synchronous reply fixture exceeded 5 seconds")), 5000);
  try {
    const leases = { caller: broker.register(), service: broker.register() };
    const fixture = new URL("./fixtures/shared-objects/sync-reply-worker.ts", import.meta.url);
    const caller = new Worker(fixture, { workerData: { owner: leases.caller.id, role: "caller", gate: gate.buffer, noLanes, closeMode } });
    const service = new Worker(fixture, { workerData: { owner: leases.service.id, role: "service", gate: gate.buffer, noLanes, closeMode } });
    workers.push(caller, service);
    function fail(error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push(failure); result.reject(failure);
    }
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
      if (value.kind === "result") {
        if (!Array.isArray(value.results)) throw new Error("Invalid synchronous reply result");
        const actual: FixtureResult = { kind: "result", results: value.results };
        if (value.error !== undefined) {
          if (typeof value.error !== "string") throw new Error("Invalid synchronous reply error");
          actual.error = value.error;
        }
        result.resolve(actual); return;
      }
      if (value.kind === "close-check") { caller.postMessage({ kind: "stop" }); return; }
      if (value.kind !== "cleanup") throw new Error("Unknown synchronous reply fixture response");
      if (lease === leases.caller && closeMode === "race") { Atomics.store(gate, 2, 1); Atomics.notify(gate, 2); }
      if (lease === leases.service && closeMode === "failure") caller.postMessage({ kind: "stop" });
    }
    function receive(lease: typeof leases.caller, value: Record<string, unknown>) {
      try { message(lease, value); } catch (error) { fail(error); }
    }
    function workerFailed(worker: Worker, error: unknown) {
      fail(error);
      if (closeMode === "failure" && worker === service) caller.postMessage({ kind: "stop" });
    }
    for (const [worker, lease] of [[caller, leases.caller], [service, leases.service]] as const) {
      worker.on("message", value => receive(lease, value));
      worker.on("error", error => workerFailed(worker, error));
      worker.once("exit", () => lease.close());
    }
    const actual = await Promise.race([result.promise, timeout.promise]);
    const exits = workers.map(worker => new Promise<number[]>(resolve => worker.once("exit", code => resolve([code]))));
    if (closeMode) service.postMessage({ kind: "stop" });
    else for (const worker of workers) worker.postMessage({ kind: "stop" });
    const codes = await Promise.race([Promise.all(exits), timeout.promise]);
    if (closeMode !== "failure" && failures.length) throw failures[0];
    expect(broker.inspectRoutes()).toEqual({ endpoints: 0, pending: 0, registrations: 0 });
    return { actual, codes, failures };
  } finally {
    clearTimeout(deadline);
    await Promise.all(workers.map(worker => worker.terminate()));
    for (const port of ports) port.close();
    broker.dispose();
  }
}

// A reply posted before Atomics.notify must be readable by the woken caller's single
// receiveMessageOnPort, as esbuild's transformSync expects, even when the broker is idle.
for (const noLanes of [false, true]) test(`a blocked caller reads a reply posted before the notify while the broker is held, lanes=${!noLanes}`, async () => {
  const { actual, codes } = await runFixture(noLanes, noLanes ? undefined : "race");
  if (noLanes) { expect(actual.results).toEqual([]); expect(actual.error).toContain("Cannot destructure property"); }
  else expect(actual).toEqual({ kind: "result", results: ["first", "second", "third"] });
  expect(codes).toEqual([[0], [0]]);
}, 7000);

test("a close-frame reserve failure with an open peer stays visible", async () => {
  const { actual, codes, failures } = await runFixture(false, "failure");
  expect(actual).toEqual({ kind: "result", results: ["first", "second", "third"] });
  expect(failures.map(error => error.message)).toEqual(["Close-frame reserve failed while peer open"]);
  expect(codes).toEqual([[0], [0]]);
}, 7000);
