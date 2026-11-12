import { FilesystemClient } from "waffle/fs/client";
import { NotificationWaitScope } from "waffle/browser/notification-wait";
import type { NotificationWaitSet } from "waffle/browser/notification-wait";
import { ProcessABI } from "waffle/proc/abi";
import { DescriptorTable } from "waffle/core/descriptors";
import { attachPipeEndpoint } from "waffle/proc/pipes";
import { WorkerProcessClient } from "waffle/proc/worker-client";
import { NetHost } from "../../src/net/host";
import type { MixedRequest } from "./mixed-worker";

type Request = Pick<MixedRequest, "filesystem" | "notifications" | "ring" | "process" | "pipe" | "gate"> & {
  combined: boolean; networkOnly: boolean; fail: boolean; duration: number;
};

async function run(req: Request) {
  const fs = new FilesystemClient(req.filesystem), descriptors = new DescriptorTable();
  const scope = new NotificationWaitScope(req.notifications, fs), host = new NetHost(req.ring, () => {});
  const client = new WorkerProcessClient({ transport: req.process, descriptors,
    codec: { export() { throw Error("unused"); }, import() { throw Error("unused"); }, discard() {} }, postMessage() {} });
  try {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const reader = attachPipeEndpoint(req.pipe);
    const fd = descriptors.open(reader, (1n << 29n) - 1n, (1n << 29n) - 1n);
    const process = new ProcessABI({ memory, fs, descriptors, service: client, pid: client.pid, signals: client.signals, wake: client.wake });
    const started = performance.now();
    const set = await scope.arm({ network: host.runtime, ...(req.combined ? { process } : {}) });
    const startup = performance.now() - started;
    let waits = 0, networkScans = 0, processScans = 0;
    const counted: NotificationWaitSet = { get covered() { return set.covered; }, get disposed() { return set.disposed; },
      sample: () => set.sample(), dispose: () => set.dispose(), setProcessSubscriptions: subs => set.setProcessSubscriptions(subs),
      wait(sample, deadline) { waits++; return set.wait(sample, deadline); } };
    const poll = host.runtime.poll.bind(host.runtime);
    host.runtime.poll = timeout => { networkScans++; return poll(timeout); };
    const proc = process.imports.poll!;
    process.imports.poll = (...args) => { processScans++; return proc(...args); };
    host.runtime.attachNotifications(counted, () => undefined); host.attach(memory);
    if (req.combined) host.attachProcessWait(process, counted, () => {});
    globalThis.postMessage({ ready: true });
    Atomics.wait(req.gate, 0, 0);
    if (req.fail) throw Error("intentional failed startup");
    new DataView(memory.buffer).setUint32(68, fd, true);
    const slots = host.slots(), start = performance.now();
    const result = req.combined && !req.networkOnly ? slots.poll_io!(64, 1, req.duration, 128) : slots.poll!(req.duration);
    return { startup, elapsed: performance.now() - start, waits, networkScans, processScans, result };
  } finally { scope.dispose(); host.runtime.dispose(); descriptors.dispose(); fs.dispose(); }
}

globalThis.onmessage = ({ data }: MessageEvent<Request>) => {
  void run(data).then(done => globalThis.postMessage({ done }), error => globalThis.postMessage({ failed: String(error) }));
};
