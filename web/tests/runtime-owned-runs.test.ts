import { expect, spyOn, test } from "bun:test";
import { createRuntime } from "waffle";
import { FilesystemService, MemoryBackend, type FilesystemConnection } from "waffle/fs";
import { FilesystemSection } from "waffle/fs/protocol";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { DescriptorTable } from "waffle/core/descriptors";
import { WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { startRun } from "../src/runner";
import type { RunRequest, WorkerMessage } from "../src/bun-executor";

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error("worker startup did not complete");
}

const pidOf = (request?: RunRequest) => request?.runtimeProcess && workerProcessState(request.runtimeProcess).pid;

for (const alreadyFinishing of [false, true]) test(`page disposal fences two roots plus an independent child (root already finishing: ${alreadyFinishing})`, async () => {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const workers: FakeWorker[] = [], events: string[] = [], ports: MessagePort[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    request?: RunRequest;
    terminated = 0;
    filesystem: boolean;
    service = new FilesystemService(new MemoryBackend());
    constructor(url: string | URL) { this.filesystem = String(url).includes("fs-worker"); workers.push(this); }
    addEventListener() {}
    postMessage(message: RunRequest | { connect: FilesystemConnection }) {
      if ("connect" in message) { ports.push(message.connect.port); this.service.connect(message.connect); } else this.request = message;
    }
    terminate() { this.terminated++; events.push(this.filesystem ? "filesystem:stop" : "process:stop"); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs-worker.js", mode: "memory" } });
  const descriptors = new DescriptorTable();
  let section: FilesystemSection | undefined;
  let entered = false;
  const diagnostics = spyOn(console, "error").mockImplementation(() => {});
  try {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const hooks = { stdout() {}, stderr() {} };
    const first = startRun({ runtime, engine: "browser", module, args: [], env: {}, moduleScope: false }, hooks);
    const second = startRun({ runtime, engine: "quickjs", module, args: [], env: {}, moduleScope: false }, hooks);
    await until(() => workers.filter(worker => worker.request).length === 2);
    const root = workers.find(worker => worker.request?.engine === "browser")!;
    const transport = root.request!.runtimeProcess!;
    const client = new WorkerProcessClient({ transport, descriptors,
      codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
      postMessage: (message: WorkerProcessMessage) => root.onmessage!({ data: message } as MessageEvent<WorkerMessage>),
      prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity(), pipeRegistry: (transport.data as { pipeRegistry: unknown }).pipeRegistry } }),
    });
    const childPid = client.spawn(client.pid, { executable: "/bin/bun", argv: ["bun"], cwd: "/", env: {}, job: -1, fds: [] });
    await until(() => workers.some(worker => pidOf(worker.request) === childPid));
    section = new FilesystemSection(root.request!.filesystem);
    section.enter(); entered = true;
    if (alreadyFinishing) first.kill(15);
    // No drain between the finishing root and owner disposal.
    const disposal = runtime.dispose();
    expect(runtime.disposed).toBe(true);
    await Promise.resolve();
    expect(workers.filter(worker => !worker.filesystem).every(worker => worker.terminated === 0)).toBe(true);
    expect(events).not.toContain("filesystem:stop");
    section.exit(); entered = false;
    await disposal;
    expect(await first.done).toEqual({ code: alreadyFinishing ? 143 : 137 });
    expect(await second.done).toEqual({ code: 137 });
    expect(workers.every(worker => worker.terminated === 1)).toBe(true);
    expect(events.at(-1)).toBe("filesystem:stop");
    expect(diagnostics.mock.calls.map(call => call.map(value => value instanceof Error ? value.stack : value))).toEqual([]);
  } finally {
    diagnostics.mockRestore();
    if (entered) section!.exit();
    descriptors.dispose();
    await runtime.dispose();
    for (const worker of workers) worker.request?.filesystem.port.close();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    if (previousIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", previousIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  }
});

for (const generic of [false, true]) test(`same-task page disposal owns an unadmitted root worker (generic: ${generic})`, async () => {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [], workers: { filesystem: boolean; starts: number; stops: number }[] = [];
  class FakeWorker {
    state: { filesystem: boolean; starts: number; stops: number };
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string | URL) { this.state = { filesystem: String(url).includes("fs-worker"), starts: 0, stops: 0 }; workers.push(this.state); }
    addEventListener() {}
    postMessage(message: { connect?: { port: MessagePort }; filesystem?: { port: MessagePort } }) {
      if (message.connect) ports.push(message.connect.port);
      else { this.state.starts++; if (message.filesystem) ports.push(message.filesystem.port); }
    }
    terminate() { this.state.stops++; }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs-worker.js", mode: "memory" } });
  const diagnostics = spyOn(console, "error").mockImplementation(() => {});
  let section: FilesystemSection | undefined, held = false, disposal: Promise<void> | undefined;
  try {
    const transport = generic ? createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer }) : undefined;
    if (transport) {
      const filesystem = runtime.filesystem.createIdentity();
      transport.data = { filesystem };
      section = new FilesystemSection(filesystem); section.enter(); held = true;
    }
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const run = startRun({ runtime, engine: "quickjs", module, args: [], env: {}, moduleScope: false, runtimeProcess: transport }, { stdout() {}, stderr() {} });
    // No preparation/microtask drain between physical Worker creation and page disposal.
    disposal = runtime.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (held) {
      expect(workers.filter(worker => worker.filesystem).every(worker => worker.stops === 0)).toBe(true);
      section!.exit(); held = false;
    }
    await disposal;
    expect(workers.filter(worker => !worker.filesystem)).toHaveLength(1);
    expect(workers.every(worker => worker.stops === 1)).toBe(true);
    expect(workers.every(worker => worker.starts === 0)).toBe(true);
    expect(await run.done).toEqual({ code: 137 });
    expect(diagnostics.mock.calls.map(call => call.map(value => value instanceof Error ? value.stack : value))).toEqual([]);
  } finally {
    if (held) section!.exit();
    await (disposal ?? runtime.dispose());
    diagnostics.mockRestore();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    if (previousIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", previousIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  }
});
