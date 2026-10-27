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
const request: { owner: string; role: "caller" | "service" } = workerData;
if (!parentPort) throw new Error("Missing native parent port");
const host = parentPort;
const service = exportSharedObjects(request.owner, { postMessage(message, transfer) {
  const ports = transfer.map(port => { assert(port instanceof NativeMessagePort); return port; });
  host.postMessage(message, ports);
} });
const sharedObjects = bindSharedObjectHost(service, { active: () => true, pending() {}, wake() {} });
const runtime = sourcePorts({ sharedObjects });
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
      for (const value of ["first", "second", "third"]) results.push(runCallSync("transform", [value]));
      host.postMessage({ kind: "result", results });
    } catch (error) { host.postMessage({ kind: "result", results, error: String(error) }); }
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
  clearInterval(interval);
  for (const port of owned) port.close();
  setImmediate(() => { service.close(); host.postMessage({ kind: "cleanup" }); host.close(); });
});
if (request.role === "caller") run = caller();
