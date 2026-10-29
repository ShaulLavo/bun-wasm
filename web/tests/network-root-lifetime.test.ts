import { expect, spyOn, test } from "bun:test";
import { createFilesystemIdentity } from "waffle/fs";
import { NetHost } from "waffle/browser/net/host";
import type { RuntimeNetwork, RuntimeNetworkHelper } from "waffle";
import { startRun } from "../src/runner";
import type { RunRequest, WorkerMessage } from "../src/bun-executor";
import { processRuntimeFixture, fixtureFilesystemConnection } from "./process-runtime-fixture";

function fixture(constructionFailure = false, directory?: Promise<{ handle: number; release(): void }>) {
  const previousWorker = globalThis.Worker;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  const isolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  const gate = Promise.withResolvers<void>();
  const posted = Promise.withResolvers<RunRequest>();
  const events: string[] = [];
  const directoryRequested = Promise.withResolvers<void>();
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    constructor() { if (constructionFailure) throw new Error("network worker construction failed"); workers.push(this); }
    postMessage(request: RunRequest) { posted.resolve(request); }
    terminate() { events.push("physical-stop"); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = processRuntimeFixture({
    fork: () => fixtureFilesystemConnection(createFilesystemIdentity(), channel.port1),
    revoke() {}, reap() {}, quiesce: () => gate.promise,
    async directoryHandle() { directoryRequested.resolve(); return directory ?? { handle: 17, release() { events.push("directory-release"); } }; },
  });
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  return {
    runtime, gate, posted, events, directoryRequested, get worker() { return workers[0]; },
    start(listening?: (port: number, helper: RuntimeNetworkHelper) => void) {
      return startRun({ runtime, module, engine: "browser", moduleScope: false, args: [], env: {}, network: {
        listening, stopped: () => events.push("network-release"),
      } }, { stdout() {}, stderr() {} });
    },
    async dispose() {
      gate.resolve();
      try { await runtime.dispose(); }
      finally {
        channel.port1.close(); channel.port2.close(); globalThis.Worker = previousWorker;
        if (location) Object.defineProperty(globalThis, "location", location); else Reflect.deleteProperty(globalThis, "location");
        if (isolation) Object.defineProperty(globalThis, "crossOriginIsolated", isolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
      }
    },
  };
}

test("root worker failure keeps its session until the filesystem physical-stop fence", async () => {
  const state = fixture();
  let helper: RuntimeNetworkHelper | undefined;
  try {
    const run = state.start((_port, owner) => { helper = owner; });
    const request = await state.posted.promise;
    const host = new NetHost(request.net!, req => state.worker!.onmessage!({ data: { type: "net", req } } as MessageEvent<WorkerMessage>), undefined, { shared: true });
    expect(host.listen("localhost", 31991)).toBeGreaterThan(0);
    state.worker!.onerror!({ preventDefault() {}, message: "abrupt failure" } as ErrorEvent);
    await Bun.sleep(5);
    expect(state.events).toEqual([]);
    expect(helper?.listenerFor(31991)).toBeGreaterThan(0);
    state.gate.resolve();
    expect(await run.done).toMatchObject({ code: 1 });
    expect(state.events).toEqual(["physical-stop", "network-release", "directory-release"]);
  } finally { await state.dispose(); }
});

test("Worker construction failure returns a fenced result without activating networking", async () => {
  const state = fixture(true);
  let activations = 0;
  const network = state.runtime.network;
  state.runtime.network = () => { activations++; return network(); };
  try {
    const run = state.start();
    state.gate.resolve();
    expect(await run.done).toMatchObject({ code: 126, error: "Error: network worker construction failed" });
    expect(activations).toBe(0);
    expect(state.events).toEqual([]);
  } finally { await state.dispose(); }
});

for (const cancel of ["kill", "dispose"] as const) test(`${cancel} during network activation never allocates or posts a late root`, async () => {
  const state = fixture();
  const capability = await state.runtime.network();
  const activation = Promise.withResolvers<RuntimeNetwork>();
  const activating = Promise.withResolvers<void>();
  let allocations = 0, posts = 0;
  state.posted.promise.then(() => { posts++; });
  state.runtime.network = () => { activating.resolve(); return activation.promise; };
  try {
    const run = state.start();
    await activating.promise;
    const disposal = cancel === "dispose" ? state.runtime.dispose() : undefined;
    if (cancel === "kill") run.kill(9);
    activation.resolve({ lookup: capability.lookup.bind(capability), createHelper(options) { allocations++; return capability.createHelper(options); } });
    state.gate.resolve();
    await disposal;
    expect((await run.done).code).toBe(137);
    await Bun.sleep(5);
    expect(allocations).toBe(0);
    expect(posts).toBe(0);
    expect(state.events).toEqual(["physical-stop"]);
  } finally { activation.resolve(capability); await state.dispose(); }
});


test("root helper receives its guest filesystem scope and releases the root after helper cleanup", async () => {
  const state = fixture();
  const network = await state.runtime.network();
  const create = spyOn(network, "createHelper");
  try {
    const run = state.start();
    const request = await state.posted.promise;
    expect(create.mock.calls[0]?.[0]).toMatchObject({ pathScope: { filesystem: request.filesystem, directory: 17 } });
    state.worker!.onerror!({ preventDefault() {}, message: "stop" } as ErrorEvent);
    state.gate.resolve();
    await run.done;
    expect(state.events).toEqual(["physical-stop", "directory-release"]);
  } finally { create.mockRestore(); await state.dispose(); }
});

test("root helper construction failure releases an acquired directory", async () => {
  const state = fixture();
  const network = await state.runtime.network();
  const create = spyOn(network, "createHelper").mockImplementation(() => { throw new Error("socket helper rejected"); });
  try {
    const run = state.start();
    state.gate.resolve();
    expect(await run.done).toMatchObject({ code: 126, error: "Error: socket helper rejected" });
    expect(state.events).toEqual(["physical-stop", "directory-release"]);
  } finally { create.mockRestore(); await state.dispose(); }
});

for (const cancel of ["kill", "dispose"] as const) test(`${cancel} while acquiring a root directory releases a late lease`, async () => {
  const directory = Promise.withResolvers<{ handle: number; release(): void }>();
  const state = fixture(false, directory.promise);
  try {
    const run = state.start();
    await state.directoryRequested.promise;
    const disposal = cancel === "dispose" ? state.runtime.dispose() : undefined;
    if (cancel === "kill") run.kill(9);
    state.gate.resolve();
    directory.resolve({ handle: 17, release() { state.events.push("directory-release"); } });
    await disposal;
    expect((await run.done).code).toBe(137);
    await Bun.sleep(0);
    expect(state.events.toSorted()).toEqual(["directory-release", "physical-stop"]);
  } finally { directory.resolve({ handle: 17, release() {} }); await state.dispose(); }
});
