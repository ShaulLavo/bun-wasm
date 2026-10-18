import { expect, test } from "bun:test";
import { createRuntime, type Runtime } from "waffle";
import { FilesystemService } from "waffle/fs/service";
import { MemoryBackend } from "waffle/fs/backend";
import type { FilesystemConnection } from "waffle/fs/protocol";
import type { RunRequest, WorkerMessage } from "../src/bun-executor";
import { workerProcessState } from "waffle/proc/worker-client";
import { createRuntimeEngineScope } from "./engine-interruption-scope";
import { setSignalDisposition, takeSignal } from "waffle/proc/signals";
import { preview1SignalClockGuest } from "./engine-interruption-preview1";

/** Keep production page ownership, allocator, filesystem admission and launchRuntime intact.
 * Only guest execution is fake; real filesystem admission uses the in-memory service.
 */
function runtimeRealm() {
  const NativeWorker = globalThis.Worker;
  const workers: FakeWorker[] = [], filesystemWorkers: FakeWorker[] = [];
  const ports = new Set<MessagePort>(), closedPorts = new Set<MessagePort>();
  const filesystemURL = "https://example.test/filesystem-worker.js";
  let runtime: Runtime;
  let disposal: Promise<void> | undefined;
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    onerror = null;
    private readonly service = new FilesystemService(new MemoryBackend());
    request?: RunRequest;
    stopped = false;
    private readonly ownedPorts = new Set<MessagePort>();
    constructor(url: string | URL) { (String(url) === filesystemURL ? filesystemWorkers : workers).push(this); }
    addEventListener() {}
    private own(port: MessagePort) {
      if (!ports.has(port)) {
        ports.add(port);
        const close = port.close.bind(port);
        port.close = () => { closedPorts.add(port); close(); };
      }
      this.ownedPorts.add(port);
    }
    postMessage(message: RunRequest | { connect: FilesystemConnection }) {
      if ("connect" in message) {
        const service = message.connect.port;
        this.own(service);
        this.service.connect(message.connect);
      } else {
        this.request = message;
        this.own(message.filesystem.port);
      }
    }
    terminate() {
      this.stopped = true;
      this.service.dispose();
      for (const port of this.ownedPorts) { port.onmessage = null; port.close(); }
    }
  }
  const restore = () => {
    // Emergency teardown cannot turn an ownership assertion green: assertions run before this.
    for (const worker of filesystemWorkers.concat(workers)) if (!worker.stopped) worker.terminate();
    for (const port of ports) if (!closedPorts.has(port)) port.close();
    globalThis.Worker = NativeWorker;
  };
  // Install constructor-failure cleanup before replacing a global or starting the page owner.
  try {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    runtime = createRuntime({ filesystem: { workerURL: filesystemURL, persistence: false } });
  } catch (error) { restore(); throw error; }
  return {
    runtime, workers, filesystemWorkers, ports, closedPorts,
    dispose() {
      return disposal ??= (async () => {
        try {
          await runtime.dispose();
          expect(filesystemWorkers).toHaveLength(1);
          expect(filesystemWorkers.concat(workers).every(worker => worker.stopped)).toBe(true);
          expect(Array.from(ports).every(port => closedPorts.has(port))).toBe(true);
        } finally { restore(); }
      })();
    },
  };
}

// Exercise the actual page-side production admission and launchRuntime. This is
// structural harness coverage; real interpreters and native waits run in browsers.
test("generic engine scope reaches real launchRuntime with the process transport", async () => {
  const realm = runtimeRealm();
  let owned: Awaited<ReturnType<typeof createRuntimeEngineScope>> | undefined;
  try {
    owned = await createRuntimeEngineScope(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), "quickjs", realm.runtime,
      "http://localhost/engine-interruption-worker.js");
    const child = owned.spawn("fixture-source");
    const deadline = Date.now() + 2_000;
    while (!realm.workers[0]?.request) {
      if (Date.now() > deadline) throw new Error("real generic launchRuntime was not reached");
      await Bun.sleep(1);
    }
    const worker = realm.workers[0]!, request = worker.request!;
    expect(request.runtimeProcess).toBeDefined();
    expect(request.args).toEqual(["/usr/libexec/engine-probe", "-e", "fixture-source"]);
    const state = workerProcessState(request.runtimeProcess!);
    expect(state.pid).toBe(child.pid);
    expect(child.signalState.buffer).toBe(state.signals.signalState.buffer);
    expect(child.signalState.byteOffset).toBe(state.signals.signalState.byteOffset);
    expect(request.runtimeProcess!.bindings.map(binding => binding.fd)).toEqual([0, 1, 2]);
    const text = new TextEncoder();
    worker.onmessage!({ data: { type: "stderr", data: text.encode("ready\n") } } as MessageEvent<WorkerMessage>);
    expect(child.stderr).toBe("ready\n");
    worker.onmessage!({ data: { type: "exit", code: 23 } } as MessageEvent<WorkerMessage>);
    expect((await owned.outcome(child)).code).toBe(23);
    expect(owned.wait(child)).toBe(23);
  } finally {
    try { await owned?.dispose(); } finally { await realm.dispose(); }
  }
  expect(realm.workers.every(worker => worker.stopped)).toBe(true);
});

for (const route of ["runtimeProcess", "owned-preview1"] as const) {
  test(`${route} page killJob handles the guest without killing its waiting controller`, async () => {
    const realm = runtimeRealm();
    let owned: Awaited<ReturnType<typeof createRuntimeEngineScope>> | undefined;
    try {
      const module = new WebAssembly.Module(route === "owned-preview1" ? preview1SignalClockGuest()
        : new Uint8Array([0,97,115,109,1,0,0,0]));
      const url = "http://localhost/engine-interruption-worker.js";
      owned = route === "runtimeProcess" ? await createRuntimeEngineScope(module, "quickjs", realm.runtime, url)
        : await createRuntimeEngineScope(module, "browser", realm.runtime, url, "preview1");
      const child = owned.spawn("fixture-source");
      const deadline = Date.now() + 2_000;
      while (!realm.workers[0]?.request) {
        if (Date.now() > deadline) throw new Error("real production guest launch was not reached");
        await Bun.sleep(1);
      }
      const request = realm.workers[0]!.request!;
      expect(request.module).toBe(module);
      expect(request.interruptible).not.toBe(true);
      // Preview1 programs run in the sibling preview1 worker, which has no Bun adapter field.
      expect(request.adapter).toBe(route === "owned-preview1" ? undefined : "bun");
      if (route === "owned-preview1") {
        expect(WebAssembly.Module.imports(request.module)).toContainEqual({ module: "runtime_proc", name: "interrupted", kind: "function" });
      }
      const supervisor = await owned.service.ready();
      const root = supervisor.get(1)!;
      setSignalDisposition(child.signalState, 2, 2);
      await owned.kill(child, 2, "page-killJob");
      expect(takeSignal(child.signalState)).toBe(2);
      // A real page job signal must not also default-kill the test's waiter.
      expect(root.result).toBeNull();
      realm.workers[0]!.onmessage!({ data: { type: "exit", code: 23 } } as MessageEvent<WorkerMessage>);
      expect((await owned.outcome(child))).toMatchObject({ kind: "exited", code: 23 });
      expect(owned.wait(child)).toBe(23);
      expect(child.jobId).not.toBe(root.job);
    } finally {
      try { await owned?.dispose(); } finally { await realm.dispose(); }
    }
    expect(realm.workers.every(worker => worker.stopped)).toBe(true);
  });
}

for (const stage of ["admission", "running"] as const) {
  test(`an engine scope failure during ${stage} cleans the real page owner and fake worker realm`, async () => {
    const NativeWorker = globalThis.Worker;
    const realm = runtimeRealm();
    let owned: Awaited<ReturnType<typeof createRuntimeEngineScope>> | undefined;
    const failed = (async () => {
      try {
        owned = await createRuntimeEngineScope(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), "quickjs", realm.runtime,
          "http://localhost/engine-interruption-worker.js");
        if (stage === "running") {
          owned.spawn("fixture-source");
          const deadline = Date.now() + 2_000;
          while (!realm.workers[0]?.request) {
            if (Date.now() > deadline) throw new Error("real guest launch was not reached before failure injection");
            await Bun.sleep(1);
          }
        }
        throw new Error(`injected ${stage} failure`);
      } finally {
        try { await owned?.dispose(); } finally { await realm.dispose(); }
      }
    })();
    await expect(failed).rejects.toThrow(`injected ${stage} failure`);
    expect(globalThis.Worker).toBe(NativeWorker);
    expect(realm.runtime.disposed).toBe(true);
    expect(realm.filesystemWorkers.concat(realm.workers).every(worker => worker.stopped)).toBe(true);
    expect(Array.from(realm.ports).every(port => realm.closedPorts.has(port))).toBe(true);
    // Only completed teardown, not a manual Symbol deletion, permits the next page owner.
    const replacement = runtimeRealm();
    await replacement.dispose();
    expect(globalThis.Worker).toBe(NativeWorker);
  });
}
