import { runInNewContext } from "node:vm";
import { FilesystemClient } from "waffle/fs/client";
import type { FilesystemConnection } from "waffle/fs/protocol";
import { NotificationWaitScope, type NotificationWaitSet } from "waffle/browser/notification-wait";
import type { NotificationConnection } from "waffle/browser/notification-relay";
import { ProcessABI } from "waffle/proc/abi";
import { DescriptorTable } from "waffle/core/descriptors";
import { attachPipeEndpoint, type PipeEndpointHandle } from "waffle/proc/pipes";
import { WorkerProcessClient, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { NetHost } from "../../src/net/host";
import { installHostSlots, installHostSlotsViaImport } from "../../src/net/trampoline";
import { slotGuest } from "./mixed-slot-guest";

export interface MixedRequest {
  filesystem: FilesystemConnection;
  notifications: NotificationConnection;
  ring: SharedArrayBuffer;
  process: WorkerProcessTransport;
  pipe: PipeEndpointHandle;
  source: string;
  transport: "table" | "imports";
  mode: "selected" | "before" | "between" | "noise" | "network-noise" | "close" | "cancel" | "uncovered";
  gate: Int32Array;
}

async function run(request: MixedRequest) {
  const fs = new FilesystemClient(request.filesystem);
  const descriptors = new DescriptorTable();
  const host = new NetHost(request.ring, () => {});
  const scope = new NotificationWaitScope(request.notifications, fs);
  const reader = attachPipeEndpoint(request.pipe);
  const service = new WorkerProcessClient({ transport: request.process, descriptors,
    codec: { export() { throw Error("Unused export"); }, import() { throw Error("Unused import"); }, discard() {} }, postMessage() {} });
  try {
    return await exercise(request, fs, descriptors, host, scope, reader, service);
  } finally { scope.dispose(); host.runtime.dispose(); descriptors.dispose(); fs.dispose(); }
}

async function exercise(request: MixedRequest, fs: FilesystemClient, descriptors: DescriptorTable, host: NetHost,
  scope: NotificationWaitScope, reader: ReturnType<typeof attachPipeEndpoint>, service: WorkerProcessClient) {
  const instance = slotGuest(), memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw Error("Missing guest memory");
  const fd = descriptors.open(reader, (1n << 29n) - 1n, (1n << 29n) - 1n);
  const process = new ProcessABI({ memory, descriptors, fs, pid: service.pid, service, signals: service.signals, wake: service.wake });
  const combined = typeof host.attachProcessWait === "function";
  const set = await scope.arm({ network: host.runtime, ...(combined ? { process } : {}) });
  let waits = 0, scans = 0, uncovered = false;
  const counted: NotificationWaitSet = { get covered() { return set.covered; }, get disposed() { return set.disposed; },
    sample: () => set.sample(), dispose: () => set.dispose(), setProcessSubscriptions: subs => set.setProcessSubscriptions(subs),
    wait(sample, deadline) {
      waits++;
      uncovered ||= !set.covered;
      globalThis.postMessage({ stage: "park" });
      if (request.mode === "between") Atomics.wait(request.gate, 0, 0, 2000);
      return set.wait(sample, deadline);
    } };
  const checkActive = () => { if (request.mode === "cancel" && Atomics.load(request.gate, 0)) throw Error("fatal cancellation"); };
  host.attach(memory); host.runtime.attachNotifications(counted, () => undefined);
  if (combined) host.attachProcessWait(process, counted, checkActive);
  const impls = host.slots();
  const networkPoll = impls.poll!;
  impls.poll = timeout => { scans++; return networkPoll(timeout); };
  let result = -99;
  const dispatch = request.transport === "imports" ? installHostSlotsViaImport(instance, impls) : undefined;
  if (!dispatch) installHostSlots(instance, impls);
  const call = (slot: number, args: number[]) => {
    if (dispatch) return dispatch(slot, args);
    const table = instance.exports.__indirect_function_table;
    if (!(table instanceof WebAssembly.Table)) throw Error("Missing table");
    return table.get(new DataView(memory.buffer).getUint32(8 + slot * 4, true))(...args);
  };
  const native = { hostCaps: { poll_io: true }, hostPollIo(bytes: Uint8Array, timeout: number) {
    // Model the Rust-owned input and separate initialized count*16 output buffers.
    new Uint8Array(memory.buffer).set(bytes, 128);
    new Uint8Array(memory.buffer, 2048, bytes.length).fill(0);
    result = call(18, [128, bytes.length / 16, timeout, 2048]); return result;
  }, procPoll() { throw Error("Unexpected process-only wait"); } };
  const internal = { native, web: {}, addIoWaiter: (_value: object) => {}, ioWait: (_timeout: number) => false,
    concatBytes: (parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => Array.from(part))) };
  runInNewContext(request.source + "})(internal);", { internal });
  const subscription = new Uint8Array(16);
  new DataView(subscription.buffer).setUint32(4, fd, true);
  internal.addIoWaiter({ ref: true, subscriptions: () => subscription });
  internal.addIoWaiter({ ref: true });
  const start = performance.now();
  let fatal = false;
  try {
    if (request.mode === "network-noise") result = call(0, [120]);
    else if (!internal.ioWait(120)) result = call(0, [120]);
  } catch (error) { if (!(error instanceof Error) || error.message !== "fatal cancellation") throw error; fatal = true; }
  const elapsed = performance.now() - start;
  const byte = new Uint8Array(1), read = reader.tryRead([byte]);
  return { result, fatal, elapsed, read, byte: byte[0], waits, scans, network: Atomics.load(new Int32Array(request.ring), 0),
    coveredAfter: set.covered, uncovered, processSequence: Atomics.load(service.wake, 0) };
}

globalThis.onmessage = ({ data }: MessageEvent<MixedRequest>) => {
  void run(data).then(done => globalThis.postMessage({ done }), error => globalThis.postMessage({ error: String(error), stack: error.stack }));
};
