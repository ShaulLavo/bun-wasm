// One side of a blocked-receiver case: real Bun worker threads running the actual worker_threads,
// worker_codec, service and realm sources. The receiver reports what a single synchronous receive
// did while it held no event-loop turn, then what a later turn delivered.
import { parentPort, workerData, MessagePort as NativeMessagePort } from "node:worker_threads";
import { bindSharedObjectHost } from "../../../web/src/shared-objects/host";
import { installSharedBufferRealm } from "../../../web/src/shared-objects/realm";
import { exportSharedObjects } from "../../../web/src/shared-objects/service";
import { sharedPoolLanes } from "../../../web/src/shared-objects/protocol";
import { sourcePorts, type SourcePort } from "./source-runtime";
import type { Graph } from "./runtime-types";

const { owner, role, gate, name } = workerData as { owner: string; role: "sender" | "receiver"; gate: SharedArrayBuffer; name: string };
if (!parentPort) throw new Error("Missing native parent port");
const host = parentPort;
const service = exportSharedObjects(owner, { postMessage(message, transfer) {
  for (const port of transfer) if (!(port instanceof NativeMessagePort)) throw new Error("Invalid native port");
  host.postMessage(message, transfer as unknown as NativeMessagePort[]);
} });
await service.ready;
installSharedBufferRealm(service.claimBuffer);
const runtime = sourcePorts({ sharedObjects: bindSharedObjectHost(service, { active: () => true, pending() {}, wake() {} }) });
const cells = new Int32Array(gate);
const pump = setInterval(() => runtime.pump(), 1);
const turn = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Received = { message: Record<string, unknown> };
type Outcome = { outcome: "returned"; kind: string; v?: unknown; signal?: number; shared?: boolean } | { outcome: "threw"; name: string; code?: string };

function summarize(value: Received | undefined): Outcome {
  if (!value) return { outcome: "returned", kind: "undefined" };
  const signal = value.message.signal;
  if (!(signal instanceof SharedArrayBuffer)) return { outcome: "returned", kind: "message", v: value.message.v };
  return { outcome: "returned", kind: "message", v: value.message.v, signal: signal.byteLength, shared: true };
}
let lastReceived: Received | undefined;
function receive(port: SourcePort): Outcome {
  try { lastReceived = runtime.receiveMessageOnPort(port) as Received | undefined; return summarize(lastReceived); }
  catch (error) { lastReceived = undefined; return { outcome: "threw", name: (error as Error).name, code: (error as { code?: string }).code }; }
}
const wasmHeader = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const senders: Record<string, (port: SourcePort, held: unknown[]) => void> = {
  stock4: port => port.postMessage({ signal: new SharedArrayBuffer(4) }),
  stockCoerced: port => port.postMessage({ signal: new SharedArrayBuffer("8" as unknown as number) }),
  stockOptions: port => port.postMessage({ signal: new SharedArrayBuffer(12, {}) }),
  stockLast: port => port.postMessage({ signal: new SharedArrayBuffer(65536) }),
  primitive: port => port.postMessage({ v: 7 }),
  preattached: (port, held) => port.postMessage({ signal: held[0] }),
  oversize: port => port.postMessage({ signal: new SharedArrayBuffer(65537) }),
  native128k: port => port.postMessage({ signal: new SharedArrayBuffer(128 * 1024) }),
  zero: port => port.postMessage({ signal: new SharedArrayBuffer(0) }),
  growable: port => port.postMessage({ signal: new SharedArrayBuffer(4, { maxByteLength: 16 }) }),
  memory: port => port.postMessage({ memory: new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }), v: "memory" }),
  module: port => port.postMessage({ module: new WebAssembly.Module(wasmHeader), v: "module" }),
  nativeAlias: port => port.postMessage({ signal: structuredClone(new SharedArrayBuffer(16)) }),
  listener: port => port.postMessage({ signal: new SharedArrayBuffer(128 * 1024) }),
  exhausted(port) {
    for (let index = 0; index < 32; index++) new SharedArrayBuffer(60);
    port.postMessage({ signal: new SharedArrayBuffer(60) });
  },
  lastAdmitted(port) {
    for (let index = 0; index < 31; index++) new SharedArrayBuffer(56);
    port.postMessage({ signal: new SharedArrayBuffer(56) });
  },
  transferred(port, held) {
    const inner = new runtime.MessageChannel();
    held.push(inner);
    inner.port1.on("message", value => host.postMessage({ kind: "inner", value }));
    inner.port1.ref();
    port.postMessage({ signal: new SharedArrayBuffer(128 * 1024), inner: inner.port2, v: 9 }, [inner.port2]);
  },
  freshReply(port, held) {
    const inner = new runtime.MessageChannel();
    held.push(inner);
    port.postMessage({ inner: inner.port2 }, [inner.port2]);
    inner.port1.postMessage({ signal: new SharedArrayBuffer(4), v: "reply" });
  },
  laneExhausted(port, held) {
    const lanes = service.lanes;
    if (!lanes) throw new Error("Shared lane pool is unavailable");
    // Deplete lifetime stock without filling the unrelated route-command mailbox.
    // The real port transfer below still crosses the exhausted-lane boundary.
    for (let index = 0; index < sharedPoolLanes; index++) held.push(lanes.create());
    const inner = new runtime.MessageChannel();
    held.push(inner);
    inner.port1.on("message", value => host.postMessage({ kind: "inner", value }));
    inner.port1.ref();
    port.postMessage({ inner: inner.port2, v: 33 }, [inner.port2]);
  },
  fifo(port) {
    port.postMessage({ v: "before" });
    port.postMessage({ signal: new SharedArrayBuffer(128 * 1024), v: "fresh" });
    port.postMessage({ v: "after" });
  },
  closeAfterError: port => port.postMessage({ signal: new SharedArrayBuffer(128 * 1024) }),
  senderExit: port => port.postMessage({ signal: new SharedArrayBuffer(24), v: "survived" }),
};

if (role === "sender") {
  const channel = new runtime.MessageChannel();
  const preattached = new SharedArrayBuffer(65537);
  host.postMessage({ kind: "initial", graph: runtime.codec.encode([channel.port2, preattached], [channel.port2]) });
  host.on("message", async (data: { kind: string }) => {
    if (data.kind !== "run") return;
    clearInterval(pump);
    const held: unknown[] = [preattached];
    senders[name]!(channel.port1, held);
    Atomics.store(cells, 0, 1); Atomics.notify(cells, 0);
    await turn(600);
    host.postMessage({ kind: "sent", state: service.inspect(), stats: service.poolStats() });
  });
} else {
  host.on("message", async (data: { kind: string; graph?: Graph }) => {
    if (data.kind !== "restore") return;
    await new Promise<void>(resolve => { if (!runtime.codec.wait(data.graph!, resolve)) resolve(); });
    const port = (runtime.codec.decode(data.graph!) as [SourcePort])[0];
    if (name === "listener") {
      const received = new Promise<Record<string, unknown>>(resolve => port.on("message", value => resolve(value as Record<string, unknown>)));
      port.ref();
      host.postMessage({ kind: "ready" });
      const value = await received;
      host.postMessage({ kind: "result", result: { asyncDelivered: true, signal: (value.signal as SharedArrayBuffer).byteLength } });
      return;
    }
    clearInterval(pump);
    host.postMessage({ kind: "ready" });
    Atomics.wait(cells, 0, 0);
    if (name === "senderExit") { host.postMessage({ kind: "sender-may-exit" }); Atomics.wait(cells, 1, 0); }
    // The original program order: wake, then exactly one receive, with no event-loop turn yet.
    const first = receive(port);
    const result: Record<string, unknown> = { first };
    if (name === "fifo") result.second = receive(port);
    if (name === "closeAfterError") {
      port.close();
      result.afterClose = receive(port);
      host.postMessage({ kind: "result", result });
      return;
    }
    if (name === "freshReply") {
      // Not yet a turn: the port it just carried is already readable, and so is the fresh buffer on it.
      result.reply = summarize(runtime.receiveMessageOnPort(lastReceived?.message.inner as SourcePort) as Received | undefined);
      host.postMessage({ kind: "result", result });
      return;
    }
    await turn(150);
    runtime.pump();
    // After a turn the same frame, whole, and everything it carried.
    const delivered = (first.outcome === "threw" || name === "fifo" ? runtime.receiveMessageOnPort(port) : lastReceived) as Received | undefined;
    result.afterTurn = summarize(delivered);
    if (name === "fifo") result.afterTurn2 = summarize(runtime.receiveMessageOnPort(port) as Received | undefined);
    const inner = delivered?.message.inner as SourcePort | undefined;
    if (inner) { result.hasPort = true; inner.postMessage({ v: "viaPort" }); await turn(100); }
    host.postMessage({ kind: "result", result });
  });
}
