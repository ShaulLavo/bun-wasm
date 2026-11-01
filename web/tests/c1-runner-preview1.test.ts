import { expect, spyOn, test } from "bun:test";
import { createFilesystemIdentity, revokeFilesystem } from "waffle/fs";
import { fixtureFilesystemConnection } from "./process-runtime-fixture";
import { socketRuntimeFixture } from "./socket-runtime-fixture";
import { startRun } from "../src/runner";
import type { RunRequest, WorkerMessage } from "../src/bun-executor";

// Source-only launcher test. No guest instance, browser, service or real worker is started.
for (const failure of [false, true]) test(`C1 Bun manual Preview 1 transfers only network metadata and disposes its owner, post failure ${failure}`, async () => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channels: MessageChannel[] = [];
  const posted = Promise.withResolvers<void>();
  const events: string[] = [];
  let request: RunRequest | undefined;
  let transfers: Transferable[] = [];
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    constructor() { workers.push(this); }
    postMessage(value: RunRequest, transfer: Transferable[]) {
      request = value; transfers = transfer; posted.resolve();
      if (failure) throw new Error("unit-only post failure");
    }
    terminate() { events.push("worker-stop"); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://127.0.0.1:43829/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = socketRuntimeFixture({
    fork() {
      const channel = new MessageChannel(); channels.push(channel);
      return fixtureFilesystemConnection(createFilesystemIdentity(), channel.port1);
    },
    connect(identity) {
      const channel = new MessageChannel(); channels.push(channel);
      return fixtureFilesystemConnection(identity, channel.port1);
    },
    revoke: revokeFilesystem, reap() {}, async quiesce(identity) { revokeFilesystem(identity); },
  });
  const network = await runtime.network();
  const make = network.createHelper.bind(network);
  const create = spyOn(network, "createHelper").mockImplementation(options => {
    const helper = make(options);
    return { ...helper, dispose() { events.push("helper-dispose"); helper.dispose(); } };
  });
  const connect = async () => { throw new Error("source-only test must not connect"); };
  const sockets = [{ fd: 3, socket: { connect: { host: "owner-echo.example", port: 4321 } } }];
  let run: ReturnType<typeof startRun> | undefined;
  try {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    run = startRun({ runtime, module, engine: "browser", adapter: "preview1", args: [], env: {}, moduleScope: false,
      network: { connect }, preview1: { sockets } }, { stdout() {}, stderr() {} });
    await posted.promise;
    expect(request?.network).toBeDefined();
    const connection = request?.network;
    if (!connection) throw new Error("manual launcher omitted request.network");
    expect(Object.keys(connection).sort()).toEqual(["port", "ring", "sockets"]);
    expect(connection.sockets).toEqual(sockets);
    expect(transfers).toContain(connection.port);
    expect(transfers).not.toContain(connection.ring);
    expect(create.mock.calls[0]?.[0].connect).toBe(connect);
    expect(request).not.toHaveProperty("relay");
    expect(request).not.toHaveProperty("connect");
    if (!failure) workers[0]?.onmessage?.(new MessageEvent("message", { data: { type: "exit", code: 0, sleep: "atomics" } }));
    expect((await run.done).code).toBe(failure ? 126 : 0);
    await runtime.dispose();
    expect(events.filter(event => event === "helper-dispose")).toHaveLength(1);
  } finally {
    run?.kill(9);
    await runtime.dispose();
    await run?.done;
    create.mockRestore();
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    globalThis.Worker = originalWorker;
    for (const [name, descriptor] of [["location", originalLocation], ["crossOriginIsolated", originalIsolation]] as const) restoreProperty(name, descriptor);
  }
});

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
}
