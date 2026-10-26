import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { parentPort, workerData, MessagePort as NativeMessagePort } from "node:worker_threads";
import { attachPipeEndpoint, type PipeEndpointHandle } from "../../../node_modules/waffle/proc/pipes.ts";
import { exportSharedObjects } from "../../../web/src/shared-objects/service";
import { sourceChannel, sourcePorts } from "./source-runtime";
import type { Graph } from "./runtime-types";

const request: { role: "sender" | "receiver"; owner: string; input: PipeEndpointHandle; output: PipeEndpointHandle; exact: string } = workerData;
if (!parentPort) throw new Error("Missing native parent port");
const host = parentPort;
const input = attachPipeEndpoint(request.input), output = attachPipeEndpoint(request.output);
const channel = sourceChannel({
  procRead() {
    const bytes = new Uint8Array(65536), count = input.tryRead([bytes]);
    return count > 0 ? bytes.subarray(0, count) : count;
  },
  procWrite(_fd: number, bytes: Uint8Array) { return output.tryWrite([bytes]); },
  procClose(fd: number) { (fd === 3 ? input : output).close(); },
  procPoll() { return 0; },
});
const sharedObjects = exportSharedObjects(request.owner, { postMessage(message, transfer) {
  const ports = transfer.map(port => { assert(port instanceof NativeMessagePort); return port; });
  host.postMessage(message, ports);
} });
let runtime: ReturnType<typeof sourcePorts>;
let interval: ReturnType<typeof setInterval> | undefined;
let senderTimer = false;
let nativeCallbacks = 0;
let decoded = 0;
function receive(value: unknown) {
  assert(value && typeof value === "object" && "sharedBuffer" in value && value.sharedBuffer instanceof SharedArrayBuffer);
  assert("id" in value && "args" in value && Array.isArray(value.args));
  const cells = new Int32Array(value.sharedBuffer);
  if ("alias" in value) {
    assert.equal(value.alias, value.sharedBuffer);
    assert("view" in value && value.view instanceof Int32Array);
    assert.equal(value.view.buffer, value.sharedBuffer);
    assert.equal(value.view.byteOffset, 4);
    assert.equal(value.view.byteLength, 4);
  }
  runtime.workerData.postMessage({ id: value.id, resolve: value.args[0] });
  channel.drain();
  Atomics.store(cells, 1, "alias" in value ? 73 : 42);
  Atomics.add(cells, 0, 1); Atomics.notify(cells, 0);
  host.postMessage({ kind: "decoded", count: ++decoded });
}
function sender() {
  const control = new runtime.MessageChannel(), reply = new runtime.MessageChannel();
  const mainPort = reply.port1;
  const worker_threads2 = runtime;
  let sentBacking: SharedArrayBuffer | undefined;
  const worker = { postMessage(value: unknown) {
    assert(value && typeof value === "object" && "sharedBuffer" in value && value.sharedBuffer instanceof SharedArrayBuffer);
    sentBacking = value.sharedBuffer;
    control.port1.postMessage(value);
  } };
  function applyProperties(error: object, properties: object) { Object.assign(error, properties); }
  const graph = runtime.codec.encode([reply.port2, [], control.port2], [reply.port2, control.port2]);
  runtime.__fixtureChild(channel, graph);
  host.postMessage({ kind: "initial", graph });
  return () => {
    runtime.pump();
    const runCallSync = runInNewContext(`${request.exact}; runCallSync;`, { nextID: 0, SharedArrayBuffer, Int32Array, Atomics, worker, worker_threads2, mainPort, applyProperties });
    assert.equal(typeof runCallSync, "function");
    setTimeout(() => { senderTimer = true; }, 0);
    const before = nativeCallbacks, started = performance.now();
    assert.equal(runCallSync("sync", ["exact-esbuild"]), "exact-esbuild");
    const elapsedMs = performance.now() - started;
    assert(sentBacking); assert.equal(Atomics.load(new Int32Array(sentBacking), 1), 42);
    assert.equal(senderTimer, false); assert.equal(nativeCallbacks, before);
    const sharedBuffer = new SharedArrayBuffer(8);
    worker.postMessage({ sharedBuffer, alias: sharedBuffer, view: new Int32Array(sharedBuffer, 4, 1), id: 1, args: ["aliases"] });
    const status = Atomics.wait(new Int32Array(sharedBuffer), 0, 0, 3000);
    assert(status === "ok" || status === "not-equal");
    assert.equal(Atomics.load(new Int32Array(sharedBuffer), 1), 73);
    assert.deepEqual(runtime.receiveMessageOnPort(mainPort), { message: { id: 1, resolve: "aliases" } });
    host.postMessage({ kind: "result", elapsedMs, exactValue: 42, aliasValue: 73, senderTimer, callbacksWhileBlocked: nativeCallbacks - before });
  };
}
let runSender: (() => void) | undefined;
function stop() {
  if (interval) clearInterval(interval);
  channel.close(); sharedObjects.close();
  host.postMessage({ kind: "cleanup", state: sharedObjects.inspect() });
  host.close();
}
host.on("message", (value: { kind: string; graph?: Graph }) => {
  nativeCallbacks++;
  if (value.kind === "stop") { stop(); return; }
  if (value.kind === "run") { runSender!(); return; }
  if (value.kind !== "initial" || !value.graph) throw new Error("Invalid fixture command");
  runtime = sourcePorts({ sharedObjects, channel, graph: value.graph });
  runtime.initialize(); runtime.parentPort.on("message", receive);
  interval = setInterval(() => runtime.pump(), 1);
  host.postMessage({ kind: "ready" });
});
if (request.role === "sender") { runtime = sourcePorts({ sharedObjects, channel }); runSender = sender(); }
