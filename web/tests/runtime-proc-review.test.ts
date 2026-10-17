import { expect, test } from "bun:test";
import { DescriptorTable } from "../../runtime/core/descriptors";
import { createFilesystemIdentity, revokeFilesystem } from "../../runtime/fs";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage, type WorkerProcessTransport } from "../../runtime/proc/worker-client";
import type { SharedFilesystem } from "../src/shared-fs";
import { SubprocessBroker } from "../src/subprocess-broker";
import type { RunRequest, WorkerMessage } from "../src/worker";

const pause = (ms = 1) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string, milliseconds = 500) {
  const end = performance.now() + milliseconds;
  while (!condition()) { if (performance.now() >= end) throw new Error(`${label} timed out`); await pause(); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options?: ConstructorParameters<typeof SubprocessBroker>[2]) {
  const NativeWorker = globalThis.Worker;
  const workers: FakeWorker[] = [];
  class FakeWorker {
    request?: RunRequest;
    onmessage?: (event: { data: WorkerMessage }) => void;
    onerror?: (event: unknown) => void;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request: RunRequest) { this.request = request; request.filesystem.port.close(); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const root = createWorkerProcessTransport(); root.data = { filesystem: createFilesystemIdentity() };
  const filesystem = {
    connect(identity: object) { const channel = new MessageChannel(); channel.port2.close(); return { ...identity, port: channel.port1 }; },
    revoke: revokeFilesystem, reap() {}, client: { sweep() {} },
    async quiesce(identity: Parameters<typeof revokeFilesystem>[0]) { revokeFilesystem(identity); },
  } as unknown as SharedFilesystem;
  const broker = new SubprocessBroker("http://localhost/worker.js", filesystem, options);
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const codec = { export() { throw new Error("unexpected descriptor export"); }, import() { throw new Error("unexpected descriptor import"); }, discard() {} };
  function client(transport: WorkerProcessTransport, send: (message: WorkerProcessMessage) => void) {
    return new WorkerProcessClient({ transport, descriptors, codec, postMessage: send,
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } }) });
  }
  const parent = client(root, message => messages.push(message));
  return { root, broker, workers, parent, client, messages,
    async dispose() {
      broker.dispose(); descriptors.dispose();
      try { await until(() => workers.every(worker => worker.terminated), "fixture workers stopped"); }
      finally { for (const worker of workers) worker.terminate(); globalThis.Worker = NativeWorker; }
    },
  };
}
const emptyModule = () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

test("generic worker loaded after first watcher tick still confirms a caught default-signal outcome", async () => {
  const loading = deferred();
  const state = fixture();
  try {
    state.broker.register("slow", { adapter: "preview1", module: async () => { await loading.promise; return emptyModule(); } });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.parent.spawn(1, { executable: "slow", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    // Let the initial four-millisecond watcher fire while module loading has no worker yet.
    await pause(25);
    expect(state.workers).toHaveLength(0);
    loading.resolve();
    await until(() => state.workers.length === 1, "delayed worker launch");
    const worker = state.workers[0]!;
    const transport = worker.request!.runtimeProcess!;
    const child = state.client(transport, message => worker.onmessage!({ data: message }));
    // Equivalent to guest JS catching its typed terminal unwind and spinning without returning.
    child.defaultSignal(pid, 15);
    await until(() => Atomics.load(workerProcessState(transport).confirmed, 0) === 1, "caught default action confirmation");
    expect(state.parent.wait(1, pid)).toEqual({ kind: "signaled", code: 15, status: 143 });
    await until(() => worker.terminated, "caught default action worker termination");
  } finally { loading.resolve(); await state.dispose(); }
});

test("already-published background spawn survives root exit during lazy supervisor activation", async () => {
  const activation = deferred(); let activating = false;
  const state = fixture({ activate: async () => { activating = true; await activation.promise; return import("../../runtime/proc"); } });
  try {
    state.broker.register("child", { adapter: "preview1", module: emptyModule() });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.parent.spawn(1, { executable: "child", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const admitted = state.broker.runtimeMessage(state.messages[0]!, 1);
    // Attach rejection immediately: the assertion below, not an unhandled rejection, owns it.
    const outcome = admitted.then(() => null, error => error);
    await until(() => activating, "lazy activation begins");
    state.parent.exit(0); state.broker.rootExit(0);
    activation.resolve();
    expect(await outcome).toBeNull();
    await until(() => state.workers.some(worker => worker.request?.pid === pid), "independent background launch");
    expect((await state.broker.ready()).get(pid)?.result).toBeNull();
  } finally { activation.resolve(); await state.dispose(); }
});
