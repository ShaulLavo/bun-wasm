import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parentPort, workerData, MessagePort as NativeMessagePort } from "node:worker_threads";
import { bindSharedObjectHost } from "../../../web/src/shared-objects/host";
import { exportSharedObjects } from "../../../web/src/shared-objects/service";
import { sourcePorts, type SourcePort } from "./source-runtime";
import type { Graph } from "./runtime-types";

// esbuild's synchronous API over worker_threads with shared routes enabled: the service side
// replies on a transferred port and then notifies; the blocked caller reads the reply once.
// The gate holds the test thread, which runs the page broker, until the caller has received.
const request: { owner: string; role: "caller" | "service" } = workerData;
if (!parentPort) throw new Error("Missing native parent port");
const host = parentPort;
const service = exportSharedObjects(request.owner, { postMessage(message, transfer) {
  const ports = transfer.map(port => { assert(port instanceof NativeMessagePort); return port; });
  host.postMessage(message, ports);
} });
const bound = bindSharedObjectHost(service, { active: () => true, pending() {}, wake() {} });
const gate = new Int32Array(workerData.gate);
let stopping = false;
function withCloseControl(shared: typeof bound): typeof bound {
  if (!workerData.closeMode || request.role !== "service" || !shared.lanes) return shared;
  const lanes = shared.lanes;
  type Lane = ReturnType<typeof lanes.open>;
  function peerClosed(lane: Lane) {
    const closed = lane.peerClosed();
    if (closed || !stopping || workerData.closeMode !== "race") return closed;
    host.postMessage({ kind: "close-check" });
    if (Atomics.load(gate, 2) === 0 && Atomics.wait(gate, 2, 0, 2000) === "timed-out") throw new Error("Caller failed to finish the coordinated close");
    return closed;
  }
  function reserve(lane: Lane, text: string) {
    if (stopping && workerData.closeMode === "failure") throw new Error("Close-frame reserve failed while peer open");
    return lane.reserve(text);
  }
  function open(buffer: SharedArrayBuffer, side: 0 | 1) {
    const lane = lanes.open(buffer, side);
    return { ...lane, peerClosed: () => peerClosed(lane), reserve: (text: string) => reserve(lane, text) };
  }
  return { ...shared, lanes: { create: lanes.create, open } };
}
const sharedObjects = withCloseControl(bound);
const runtime = sourcePorts({ sharedObjects: workerData.noLanes ? { ...sharedObjects, lanes: undefined } : sharedObjects });
let gateRound = 0;
const exact = readFileSync(new URL("./esbuild-run-call-sync.txt", import.meta.url), "utf8");
const owned: SourcePort[] = [];
const interval = setInterval(() => runtime.pump(), 1);

function serve(graph: Graph) {
  const [reply, control] = runtime.codec.decode(graph) as SourcePort[];
  assert(reply instanceof runtime.MessagePort && control instanceof runtime.MessagePort);
  owned.push(reply, control);
  control.on("message", (value: unknown) => {
    assert(value && typeof value === "object" && "sharedBuffer" in value && value.sharedBuffer instanceof SharedArrayBuffer);
    assert("id" in value && "args" in value && Array.isArray(value.args));
    const cells = new Int32Array(value.sharedBuffer);
    const round = ++gateRound;
    host.postMessage({ kind: "gate", round });
    if (Atomics.load(gate, 0) < round) Atomics.wait(gate, 0, round - 1, 2000);
    reply.postMessage({ id: value.id, resolve: value.args[0] });
    Atomics.add(cells, 0, 1); Atomics.notify(cells, 0, Infinity);
  });
  host.postMessage({ kind: "ready" });
}
function caller() {
  const control = new runtime.MessageChannel(), reply = new runtime.MessageChannel();
  owned.push(control.port1, reply.port1);
  const worker = { postMessage: (value: unknown) => control.port1.postMessage(value) };
  host.postMessage({ kind: "initial", graph: runtime.codec.encode([reply.port2, control.port2], [reply.port2, control.port2]) });
  return () => {
    const runCallSync = runInNewContext(`${exact}; runCallSync;`, { nextID: 0, SharedArrayBuffer, Int32Array, Atomics, worker, worker_threads2: runtime, mainPort: reply.port1, applyProperties() {} });
    const results: unknown[] = [];
    try {
      for (const value of ["first", "second", "third"]) {
        results.push(runCallSync("transform", [value]));
        Atomics.add(gate, 1, 1); Atomics.notify(gate, 1);
      }
      host.postMessage({ kind: "result", results });
    } catch (error) { Atomics.add(gate, 1, 1); Atomics.notify(gate, 1); host.postMessage({ kind: "result", results, error: String(error) }); }
  };
}
let run: (() => void) | undefined;
host.on("message", (value: { kind: string; graph?: Graph }) => {
  if (value.kind === "restore" && value.graph) {
    const graph = value.graph;
    if (!runtime.codec.wait(graph, () => serve(graph))) serve(graph);
    return;
  }
  if (value.kind === "run" && run) { run(); return; }
  if (value.kind !== "stop") throw new Error("Invalid synchronous reply fixture command");
  stopping = true;
  clearInterval(interval);
  for (const port of owned) port.close();
  setImmediate(() => { service.close(); host.postMessage({ kind: "cleanup" }); host.close(); });
});
if (request.role === "caller") run = caller();
