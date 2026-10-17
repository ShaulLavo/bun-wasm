import { expect, test } from "bun:test";
import { createFilesystemIdentity, revokeFilesystem } from "../../runtime/fs";
import type { SharedFilesystem } from "../src/shared-fs";
import type { RunRequest, WorkerMessage } from "../src/worker";
import { workerProcessState } from "../../runtime/proc/worker-client";
import { createRuntimeEngineScope } from "./engine-interruption-scope";

// Exercise the actual page-side production admission and launchRuntime. This is
// structural harness coverage; real interpreters and native waits run in browsers.
test("generic engine scope reaches real launchRuntime without legacy ChildTransport", async () => {
  const NativeWorker = globalThis.Worker;
  const workers: FakeWorker[] = [], ports: MessagePort[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    onerror = null;
    request?: RunRequest;
    stopped = false;
    constructor() { workers.push(this); }
    postMessage(request: RunRequest) { this.request = request; }
    terminate() { this.stopped = true; }
  }
  const identity = createFilesystemIdentity();
  const fs = { client: { connection: identity, sweep() {} }, revoke: revokeFilesystem, reap() {},
    async quiesce(value: typeof identity) { revokeFilesystem(value); },
    connect(value: typeof identity) {
      const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
      return { ...value, port: channel.port1 };
    },
  } as unknown as SharedFilesystem;
  let owned: Awaited<ReturnType<typeof createRuntimeEngineScope>> | undefined;
  // Arm teardown before substituting Worker or allocating the scope.
  try {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    owned = await createRuntimeEngineScope(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])), "quickjs", fs,
      "http://localhost/engine-interruption-worker.js");
    const child = owned.spawn("fixture-source");
    const deadline = Date.now() + 2_000;
    while (!workers[0]?.request) {
      if (Date.now() > deadline) throw new Error("real generic launchRuntime was not reached");
      await Bun.sleep(1);
    }
    const worker = workers[0]!, request = worker.request!;
    expect(request.child).toBeUndefined();
    expect(request.runtimeProcess).toBeDefined();
    expect(request.budget).toBeInstanceOf(SharedArrayBuffer);
    expect(request.args).toEqual(["bun", "-e", "fixture-source"]);
    expect(request.pid).toBe(child.pid);
    const state = workerProcessState(request.runtimeProcess!);
    expect(child.signalState.buffer).toBe(state.signals.signalState.buffer);
    expect(child.signalState.byteOffset).toBe(state.signals.signalState.byteOffset);
    expect(request.runtimeProcess!.bindings.map(binding => binding.fd)).toEqual([0, 1, 2]);
    const text = new TextEncoder();
    worker.onmessage!({ data: { type: "stderr", data: text.encode("ready\n") } } as MessageEvent<WorkerMessage>);
    expect(child.stderr).toBe("ready\n");
    worker.onmessage!({ data: { type: "exit", code: 23 } } as MessageEvent<WorkerMessage>);
    expect((await owned.broker.wait(child.pid)).code).toBe(23);
    expect(owned.wait(child)).toBe(23);
  } finally {
    owned?.dispose();
    for (const port of ports) port.close();
    globalThis.Worker = NativeWorker;
    revokeFilesystem(identity);
  }
  expect(workers.every(worker => worker.stopped)).toBe(true);
});
