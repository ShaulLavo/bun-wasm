import assert from "node:assert/strict";
import { parentPort, workerData, MessagePort as NativeMessagePort } from "node:worker_threads";
import { bindSharedObjectHost } from "../../../web/src/shared-objects/host";
import { exportSharedObjects } from "../../../web/src/shared-objects/service";
import { sourcePorts, type SourcePort } from "./source-runtime";

const request: { owner: string; role: "sender" | "receiver" } = workerData;
if (!parentPort) throw new Error("Missing native parent port");
const host = parentPort;
const service = exportSharedObjects(request.owner, { postMessage(message, transfer) {
  const ports = transfer.map(port => { assert(port instanceof NativeMessagePort); return port; });
  host.postMessage(message, ports);
} });
const sharedObjects = bindSharedObjectHost(service, { active: () => true, pending() {}, wake() {} });
const runtime = sourcePorts({ sharedObjects });
const owned = new Set<SourcePort>();
let source: SourcePort | undefined, reply: SourcePort | undefined;
let callbacks = 0;
function port(value: unknown) {
  assert(value instanceof runtime.MessagePort); owned.add(value); return value;
}
function synchronousReply(endpoint: SourcePort) {
  const mailbox = service.mailbox;
  assert(mailbox);
  const header = new Int32Array(mailbox.buffer, 0, 4), deadline = Date.now() + 3000;
  let result: ReturnType<typeof runtime.receiveMessageOnPort>;
  while (!(result = runtime.receiveMessageOnPort(endpoint))) {
    const remaining = deadline - Date.now();
    assert(remaining > 0, "Synchronous routed reply deadline");
    const cursor = Atomics.load(header, 0);
    if (cursor === Atomics.load(header, 1)) Atomics.wait(header, 0, cursor, remaining);
  }
  return result;
}
host.on("message", (message: { kind: string; graph?: unknown }) => {
  callbacks++;
  if (message.kind === "restore") {
    source = port(runtime.codec.decode(message.graph));
    host.postMessage({ kind: "ready" }); return;
  }
  if (message.kind === "send") {
    assert(source);
    const channel = new runtime.MessageChannel();
    reply = channel.port1; owned.add(reply);
    const buffer = new ArrayBuffer(8), shared = new SharedArrayBuffer(8);
    new Uint8Array(buffer)[0] = 42;
    source.postMessage({ buffer, shared, alias: shared, port: channel.port2 }, [buffer, channel.port2]);
    assert.equal(buffer.byteLength, 0);
    host.postMessage({ kind: "sent" });
    const callbacksBefore = callbacks;
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const result = synchronousReply(reply);
    assert.deepEqual(result, { message: "λ reply 😀" });
    clearTimeout(timer);
    host.postMessage({ kind: "replied", callbacksWhileBlocked: callbacks - callbacksBefore, timerFired }); return;
  }
  if (message.kind !== "stop") throw new Error("Invalid mailbox fixture command");
  clearInterval(interval);
  for (const value of owned) value.close();
  setImmediate(() => { service.close(); host.postMessage({ kind: "cleanup", state: service.inspectRoutes() }); host.close(); });
});
function receive(value: unknown) {
  assert(value && typeof value === "object" && "buffer" in value && value.buffer instanceof ArrayBuffer);
  assert.equal(new Uint8Array(value.buffer)[0], 42);
  assert("shared" in value && value.shared instanceof SharedArrayBuffer && "alias" in value);
  assert.equal(value.shared, value.alias);
  assert("port" in value);
  port(value.port).postMessage("λ reply 😀");
  host.postMessage({ kind: "received" });
}
const interval = setInterval(() => {
  runtime.pump();
  if (!source || request.role !== "receiver") return;
  const packet = runtime.receiveMessageOnPort(source);
  if (packet) receive(packet.message);
}, 1);
if (request.role === "sender") {
  const channel = new runtime.MessageChannel();
  source = channel.port1; owned.add(source);
  host.postMessage({ kind: "initial", graph: runtime.codec.encode(channel.port2, [channel.port2]) });
}
