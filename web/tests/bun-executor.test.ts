import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { createFilesystemConnection, revokeFilesystem } from "waffle/fs";
import { controlAdd, controlLoad } from "waffle/proc/control";
import { WasiExit } from "waffle/core";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { bootstrap, type RuntimeWorkerHost } from "waffle/browser/worker";
import { createRing } from "waffle/browser/net/ring";
import { DefaultSignal } from "../src/default-signal";
import type { BunExecutorHost, RunRequest, WorkerMessage } from "../src/bun-executor";
import { guest, PROCESS_IMPORTS } from "../../scripts/fixtures/shared-objects/executor-guest";
import { createSharedObjectBroker } from "../src/shared-objects/broker";
import type { SharedObjectService } from "../src/shared-objects/service";
import { installLookupServer } from "../src/net/lookup";

// The Bun executor is Waffle's bootstrap plus Bun policy. These tests run the real bootstrap with
// an injected host and a hand-assembled guest; only the browser engine host is replaced.
const actualEngineHost = { ...await import("../src/engine-host.js") };
const actualTrampoline = { ...await import("../src/net/trampoline") };
const actualControl = { ...await import("waffle/proc/control") };
const actualLink = { ...await import("waffle/link") };
let linkedFinishFailure: Error | undefined;
mock.module("waffle/link", () => ({ ...actualLink, linkedWorkerHooks() {
  const hooks = actualLink.linkedWorkerHooks();
  return { ...hooks, beforeFinish() {
    hooks.beforeFinish?.();
    if (linkedFinishFailure) throw linkedFinishFailure;
  } };
} }));
// Test-only observation of Waffle's existing exported wait boundary. Production captures
// Atomics.wait before guest code runs; changing that global must not affect it.
let observeWait: typeof actualControl.controlWait | undefined;
mock.module("waffle/proc/control", () => ({ ...actualControl,
  controlWait: (...args: Parameters<typeof actualControl.controlWait>) =>
    (observeWait ?? actualControl.controlWait)(...args),
}));
// The guest-facing slot installation is replaced by a recorder; the executor's own wrappers are kept.
const installed: Record<string, (...args: number[]) => number>[] = [];
mock.module("../src/net/trampoline", () => ({ ...actualTrampoline,
  installHostSlotsViaImport: (_instance: unknown, impls: Record<string, (...args: number[]) => number>) => { installed.push(impls); return null; } }));
const startEngineHost = mock(async (_options: Record<string, unknown>): Promise<number> => 0);
mock.module("../src/engine-host.js", () => ({ startEngineHost }));
const { createBunExecutor } = await import("../src/bun-executor");
// Module mocks are process-wide in `bun test`: leave the real engine host for the other files.
afterAll(() => { mock.module("../src/engine-host.js", () => actualEngineHost); mock.module("../src/net/trampoline", () => actualTrampoline); mock.module("waffle/proc/control", () => actualControl); mock.module("waffle/link", () => actualLink); });

async function run(options: Partial<Pick<RunRequest, "engine" | "adapter" | "slots" | "env" | "net">> & { ready?: number; fetched?: string[]; onFetch?(): void } = {}) {
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport({ pid: 1, job: 1 });
  const messages: WorkerMessage[] = [];
  const fetched: string[] = [];
  const host: BunExecutorHost & RuntimeWorkerHost = {
    crossOriginIsolated: true,
    location: { href: "https://example.test/worker.js" },
    postMessage(message: WorkerMessage) { messages.push(message); },
    async fetch(input) { fetched.push(String(input)); return new Response("ok"); },
  };
  const request: RunRequest = {
    engine: options.engine ?? "browser", adapter: options.adapter, module: guest(options.ready ?? 1),
    args: ["bun"], env: options.env ?? {}, filesystem: connection.client, runtimeProcess,
    trace: false, net: options.net ?? null, moduleCache: null, slots: options.slots,
  };
  try {
    await bootstrapBun(request, host);
    return { messages, fetched, signals: workerProcessState(runtimeProcess).signals, request };
  } finally { connection.client.port.close(); connection.server.port.close(); }
}
/** The real bootstrap with its filesystem calls kept local, so no service must share this thread. */
async function bootstrapBun(request: RunRequest, host: BunExecutorHost & RuntimeWorkerHost): Promise<void> {
  const executor = createBunExecutor(request, host);
  await bootstrap(request, { ...executor, setup(context) {
    context.fs.preopen = () => 1;
    context.fs.retain = () => {};
    context.fs.release = () => {};
    executor.setup?.(context);
  } }, host);
}
/** Like run(), but hands the caller the process's shared signal words before the guest starts. */
async function runCapturingSignals(capture: (signals: ReturnType<typeof workerProcessState>["signals"]) => void, net: SharedArrayBuffer) {
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport({ pid: 1, job: 1 });
  capture(workerProcessState(runtimeProcess).signals);
  const messages: WorkerMessage[] = [];
  const host: BunExecutorHost & RuntimeWorkerHost = {
    crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
    postMessage(message: WorkerMessage) { messages.push(message); },
    async fetch() { return new Response("ok"); },
  };
  const request: RunRequest = { engine: "browser", module: guest(1), args: ["bun"], env: {}, filesystem: connection.client,
    runtimeProcess, trace: false, net, moduleCache: null };
  try { await bootstrapBun(request, host); }
  finally { connection.client.port.close(); connection.server.port.close(); }
  return { messages };
}
const exits = (messages: WorkerMessage[]) => messages.filter(message => message.type === "exit" || message.type === "error");

test("importing the executor module installs no worker message handler", () => {
  expect((globalThis as { onmessage?: unknown }).onmessage ?? null).toBeNull();
});

test("a ready browser guest exits with the status its engine host reports", async () => {
  startEngineHost.mockClear();
  startEngineHost.mockImplementationOnce(async options => { (options.onExit as (code: number) => void)(5); return 0; });
  const { messages } = await run();
  expect(startEngineHost).toHaveBeenCalledTimes(1);
  expect(exits(messages)).toEqual([{ type: "exit", code: 5, signal: undefined, sleep: "atomics" }]);
});

for (const [label, options] of [
  ["a non-browser engine", { engine: "quickjs" as const }],
  ["a preview1 run", { adapter: "preview1" as const }],
  ["a guest that is not ready", { ready: 0 }],
] as const) test(`${label} never starts the browser engine host`, async () => {
  startEngineHost.mockClear();
  const { messages } = await run(options);
  expect(startEngineHost).not.toHaveBeenCalled();
  expect(exits(messages)).toEqual([{ type: "exit", code: 0, signal: undefined, sleep: "atomics" }]);
});

test("the engine host gets the page's networking surface only when slots are on", async () => {
  startEngineHost.mockClear();
  await run({ slots: "off" });
  expect(startEngineHost.mock.calls[0]![0]!.net).toBeUndefined();
  startEngineHost.mockClear();
  await run();
  // No networking ring was supplied, so there is no host to advertise.
  expect(startEngineHost.mock.calls[0]![0]!.net).toBeUndefined();
});

test("the browser engine host receives the runtime-owned DNS provider", async () => {
  startEngineHost.mockClear();
  const channel = new MessageChannel();
  let serverCalls = 0;
  const disposeLookup = installLookupServer(channel.port1, {
    lookup(hostname, options) {
      serverCalls++;
      expect(hostname).toBe("localhost");
      expect(options).toEqual({ family: 0, hints: 0 });
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport({ pid: 1, job: 1 });
  const messages: WorkerMessage[] = [];
  const host: BunExecutorHost & RuntimeWorkerHost = {
    crossOriginIsolated: true,
    location: { href: "https://example.test/worker.js" },
    postMessage(message: WorkerMessage) { messages.push(message); },
    async fetch() { return new Response("ok"); },
  };
  const request: RunRequest = {
    engine: "browser", module: guest(1), args: ["bun"], env: {}, filesystem: connection.client,
    runtimeProcess, trace: false, net: createRing(), moduleCache: null, slots: "imports", lookupPort: channel.port2,
  };
  startEngineHost.mockImplementationOnce(async options => {
    const network = options.net as { natives: { hostLookup(hostname: string, family: 0 | 4 | 6, hints: number): Promise<unknown[]> } };
    expect(network).toBeDefined();
    expect(await network.natives.hostLookup("localhost", 0, 0)).toEqual([{ address: "127.0.0.1", family: 4 }]);
    (options.onExit as (code: number) => void)(0);
    return 0;
  });
  try {
    await bootstrapBun(request, host);
  } finally {
    disposeLookup();
    connection.client.port.close();
    connection.server.port.close();
  }
  expect(serverCalls).toBe(1);
  expect(exits(messages)).toEqual([{ type: "exit", code: 0, signal: undefined, sleep: "atomics" }]);
});

for (const kind of ["exited", "signaled"] as const) test(`engine host fetch preserves its native receiver and stops after an authoritative ${kind} outcome`, async () => {
  startEngineHost.mockClear();
  let signals!: ReturnType<typeof workerProcessState>["signals"];
  const fetched: string[] = [];
  const code = kind === "exited" ? 23 : 15;
  let blocked: unknown;
  let liveText: string | undefined;
  let receiver: unknown;
  startEngineHost.mockImplementationOnce(async options => {
    const fetch = options.fetch as (input: string) => Promise<Response>;
    liveText = await (await fetch("https://example.test/live")).text();
    claimOutcome(signals.outcome, { kind, code });
    try { await fetch("https://example.test/dead"); }
    catch (error) { blocked = error; }
    return 0;
  });
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport({ pid: 1, job: 1 });
  signals = workerProcessState(runtimeProcess).signals;
  const messages: WorkerMessage[] = [];
  const host: BunExecutorHost & RuntimeWorkerHost = {
    crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
    postMessage(message: WorkerMessage) { messages.push(message); },
    async fetch(input) {
      // oxlint-disable-next-line typescript/no-this-alias -- Capture the actual fake worker or receiver for assertions outside this callback.
      receiver = this;
      fetched.push(String(input));
      return new Response("ok");
    },
  };
  const request: RunRequest = { engine: "browser", module: guest(1), args: ["bun"], env: {}, filesystem: connection.client,
    runtimeProcess, trace: false, net: null, moduleCache: null };
  try { await bootstrapBun(request, host); }
  finally { connection.client.port.close(); connection.server.port.close(); }
  // Assert outside the engine callback: bootstrap deliberately catches guest failures.
  expect(receiver).toBe(host);
  expect(liveText).toBe("ok");
  if (kind === "signaled") {
    expect(blocked).toBeInstanceOf(DefaultSignal);
    expect((blocked as DefaultSignal).signal).toBe(code);
  } else {
    expect(blocked).toBeInstanceOf(WasiExit);
    expect((blocked as WasiExit).code).toBe(code);
  }
  const status = kind === "signaled" ? 128 + code : code;
  expect(fetched).toEqual(["https://example.test/live"]);
  expect(readOutcome(signals.outcome)).toEqual({ kind, code, status });
  expect(exits(messages)).toEqual([{ type: "exit", code: status, signal: kind === "signaled" ? code : undefined, sleep: "atomics" }]);
});

test("every network slot refuses to run once the process has a fatal outcome", async () => {
  const { SLOT_NAMES } = actualTrampoline;
  const { createRing } = await import("../src/net/ring");
  installed.length = 0;
  startEngineHost.mockClear();
  let signals!: ReturnType<typeof workerProcessState>["signals"];
  startEngineHost.mockImplementationOnce(async () => {
    const slots = installed[0]!;
    expect(Object.keys(slots).sort()).toEqual(SLOT_NAMES.slice().sort());
    claimOutcome(signals.outcome, { kind: "signaled", code: 15 });
    // The guard runs before the slot touches guest memory or the network ring.
    for (const name of SLOT_NAMES) expect(() => slots[name]!(0, 0, 0, 0), name).toThrow(DefaultSignal);
    return 0;
  });
  const result = await runCapturingSignals(options => { signals = options; }, createRing());
  expect(installed).toHaveLength(1);
  expect(exits(result.messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "atomics" }]);
});

for (const kind of ["exited", "signaled"] as const) test(`every process import checks authoritative ${kind} admission before guest memory or service access`, async () => {
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport({ pid: 1, job: 1 });
  const signals = workerProcessState(runtimeProcess).signals;
  const messages: WorkerMessage[] = [];
  const host: BunExecutorHost & RuntimeWorkerHost = {
    crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
    postMessage(message: WorkerMessage) { messages.push(message); },
    async fetch() { throw new Error("a dead process must not fetch"); },
  };
  const request: RunRequest = { engine: "browser", module: guest(0, PROCESS_IMPORTS.map(name => ({ namespace: "runtime_proc", name }))), args: ["/bin/bun"], env: {},
    filesystem: connection.client, runtimeProcess, trace: false, net: null, moduleCache: null };
  const executor = createBunExecutor(request, host);
  const refused = new Map<string, unknown>();
  let imports: Record<string, (...args: number[]) => unknown> = {};
  let memoryReads = 0;
  let serviceMessages = 0;
  try {
    await bootstrap(request, { ...executor,
      setup(context) {
        context.fs.preopen = () => 1;
        context.fs.retain = () => {};
        context.fs.release = () => {};
        executor.setup?.(context);
      },
      imports(linked) { imports = linked.runtime_proc as typeof imports; },
      run({ instance }) {
        const memory = instance.exports.memory as WebAssembly.Memory;
        // An invalid pointer alone is insufficient: an ABI might swallow its fault and
        // still return. Poison the memory accessor and assert it is never inspected.
        Object.defineProperty(memory, "buffer", { configurable: true, get() {
          memoryReads++;
          throw new Error("dead process inspected guest memory");
        } });
        try {
          claimOutcome(signals.outcome, { kind, code: kind === "signaled" ? 15 : 23 });
          const before = messages.length;
          for (const [name, call] of Object.entries(imports)) {
            try { call(0x7fffffff, 0x7fffffff, 0x7fffffff, 0x7fffffff, 0x7fffffff); }
            catch (error) { refused.set(name, error); }
          }
          // Fatal admission may notify the supervisor of the already-selected exit.
          // It must not invoke a guest-requested process service or inspect memory.
          const notifications = messages.slice(before);
          for (const message of notifications) {
            expect(message).toMatchObject({ type: "runtime-proc", operation: "exit", targets: [1] });
          }
          serviceMessages = notifications.filter(message => message.type !== "runtime-proc" || message.operation !== "exit").length;
        } finally { Reflect.deleteProperty(memory, "buffer"); }
        return 0;
      },
    }, host);
  } finally { connection.client.port.close(); connection.server.port.close(); }
  // Keep this list explicit, so silently dropping an import cannot reduce coverage.
  expect(Object.keys(imports).sort()).toEqual([
    "access_cancel", "access_start", "access_take", "default_signal", "dup", "getpid",
    "interrupted", "job_of", "kill", "kill_job", "pipe", "poll", "read", "signal", "spawn",
    "wait", "wait_job", "write",
  ]);
  expect(Array.from(refused.keys()).sort()).toEqual(Object.keys(imports).sort());
  for (const [name, error] of refused) {
    expect(error, name).toBeInstanceOf(kind === "signaled" ? DefaultSignal : WasiExit);
  }
  expect(memoryReads).toBe(0);
  expect(serviceMessages).toBe(0);
  expect(exits(messages)).toEqual([{ type: "exit", code: kind === "signaled" ? 143 : 23,
    signal: kind === "signaled" ? 15 : undefined, sleep: "atomics" }]);
});

test("without a networking ring no slots are installed", async () => {
  installed.length = 0;
  await run();
  expect(installed).toEqual([]);
});

// These tests invoke the actual linked imports. Descriptor readiness and the existing
// exported controlWait boundary are test-only observation/injection points; neither the
// ABI scanner nor bootstrap wait guards are substituted. All state is test-owned.
for (const route of ["runtime_proc", "wasi_snapshot_preview1"] as const) {
  const importName = route === "runtime_proc" ? "poll" : "poll_oneoff";
  for (const stage of ["before", "after"] as const) {
    for (const terminal of (stage === "before" ? ["exited", "revoked"] : ["exited", "signaled", "revoked"]) as ("exited" | "signaled" | "revoked")[]) {
      test(`${route} checks ${terminal} liveness ${stage} its native wait`, async () => {
        const connection = createFilesystemConnection();
        const transport = createWorkerProcessTransport();
        const state = workerProcessState(transport);
        const messages: WorkerMessage[] = [];
        const host: BunExecutorHost & RuntimeWorkerHost = {
          crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
          postMessage(message: WorkerMessage) { messages.push(message); },
          async fetch() { throw new Error("unexpected fetch"); },
        };
        const request: RunRequest = { engine: "browser", module: guest(0, [{ namespace: route, name: importName }]),
          args: ["/bin/bun"], env: {}, filesystem: connection.client, runtimeProcess: transport,
          trace: false, net: null, moduleCache: null };
        const executor = createBunExecutor(request, host);
        let call!: (...args: number[]) => unknown;
        let waits = 0, scans = 0;
        let failure: unknown;
        const select = () => {
          if (terminal === "revoked") revokeFilesystem(connection.client);
          else claimOutcome(state.signals.outcome, { kind: terminal, code: terminal === "signaled" ? 15 : 23 });
        };
        try {
          await bootstrap(request, { ...executor,
            setup(context) {
              context.fs.preopen = () => 1; context.fs.retain = () => {}; context.fs.release = () => {};
              executor.setup?.(context);
            },
            imports(linked) { call = (linked[route] as Record<string, (...args: number[]) => unknown>)[importName]!; },
            run({ instance, wasi }) {
              const fd = wasi.descriptors.open({ kind: "pipe", notification: state.wake,
                read: () => -6, write: () => -6,
                readiness() { scans++; if (stage === "before") select(); return { readable: false, writable: false, hangup: false }; },
              }, 1n << 27n, 0n);
              const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
              if (route === "runtime_proc") { view.setUint32(0, 0, true); view.setUint32(4, fd, true); }
              else { view.setUint8(8, 1); view.setUint32(16, fd, true); }
              observeWait = (word, index, _expected) => {
                expect(word.buffer).toBe(state.wake.buffer);
                expect(word.byteOffset + index * 4).toBe(state.wake.byteOffset);
                waits++; select(); return "timed-out";
              };
              try { if (route === "runtime_proc") call(0, 1, 1000, 128); else call(0, 128, 1, 256); }
              catch (error) { failure = error; throw error; }
              finally { observeWait = undefined; }
              throw new Error("selected death escaped the production wait guard");
            },
          }, host);
          expect(scans).toBe(1);
          expect(waits).toBe(stage === "before" ? 0 : 1);
          expect(failure).toBeInstanceOf(terminal === "signaled" ? DefaultSignal : WasiExit);
          expect(exits(messages)).toContainEqual({ type: "exit", code: terminal === "signaled" ? 143 : terminal === "exited" ? 23 : 1,
            signal: terminal === "signaled" ? 15 : undefined, sleep: "atomics" });
        } finally { observeWait = undefined; connection.client.port.close(); connection.server.port.close(); }
      });
    }
  }

  test(`${route} passes the original pre-scan readiness snapshot to native wait`, async () => {
    const connection = createFilesystemConnection();
    const transport = createWorkerProcessTransport();
    const state = workerProcessState(transport);
    const host: BunExecutorHost & RuntimeWorkerHost = {
      crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
      postMessage() {}, async fetch() { throw new Error("unexpected fetch"); },
    };
    const request: RunRequest = { engine: "browser", module: guest(0, [{ namespace: route, name: importName }]),
      args: ["/bin/bun"], env: {}, filesystem: connection.client, runtimeProcess: transport,
      trace: false, net: null, moduleCache: null };
    const executor = createBunExecutor(request, host);
    let call!: (...args: number[]) => unknown;
    let waits = 0, scans = 0;
    let result: unknown;
    let nativeResult: ReturnType<typeof actualControl.controlWait> | undefined;
    let original = -1;
    try {
      await bootstrap(request, { ...executor,
        setup(context) {
          context.fs.preopen = () => 1; context.fs.retain = () => {}; context.fs.release = () => {};
          executor.setup?.(context);
        },
        imports(linked) { call = (linked[route] as Record<string, (...args: number[]) => unknown>)[importName]!; },
        run({ instance, wasi }) {
          const fd = wasi.descriptors.open({ kind: "pipe", notification: state.wake,
            read: () => -6, write: () => -6,
            readiness() {
              scans++;
              if (scans === 1) controlAdd(state.wake, 0, 1);
              return { readable: scans > 1, writable: false, hangup: false };
            },
          }, 1n << 27n, 0n);
          const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
          if (route === "runtime_proc") { view.setUint32(0, 0, true); view.setUint32(4, fd, true); }
          else { view.setUint8(8, 1); view.setUint32(16, fd, true); }
          original = controlLoad(state.wake, 0);
          observeWait = (word, index, expected) => {
            waits++;
            expect(word.buffer).toBe(state.wake.buffer);
            expect(word.byteOffset + index * 4).toBe(state.wake.byteOffset);
            expect(expected).toBe(original);
            expect(actualControl.controlLoad(word, index)).toBe(original + 1);
            // Calling the real native primitive proves the old snapshot refuses sleep.
            nativeResult = actualControl.controlWait(word, index, expected, 0);
            return nativeResult;
          };
          try { result = route === "runtime_proc" ? call(0, 1, 1000, 128) : call(0, 128, 1, 256); }
          finally { observeWait = undefined; }
          if (route !== "runtime_proc") expect(view.getUint32(256, true)).toBe(1);
          return 0;
        },
      }, host);
      expect(scans).toBe(2);
      expect(waits).toBe(1);
      expect(nativeResult).toBe("not-equal");
      expect(result).toBe(route === "runtime_proc" ? 1 : 0);
    } finally { observeWait = undefined; connection.client.port.close(); connection.server.port.close(); }
  });
}

test("paired executor initializes the shared side once and releases its table range", async () => {
  const { quickjsPair } = await import("../../tests/package/quickjs-plan-fixture");
  const { prepareQuickjsProgram, programLinkPlan } = await import("../../src/assets");
  const { core, side } = quickjsPair();
  const module = await prepareQuickjsProgram(core, side);
  const connection = createFilesystemConnection();
  const messages: WorkerMessage[] = [];
  const request: RunRequest = { engine: "quickjs", module: structuredClone(module), linkPlan: programLinkPlan(module),
    args: ["bun"], env: {}, filesystem: connection.client, trace: false, net: null, moduleCache: null, slots: "off" };
  const host: BunExecutorHost & RuntimeWorkerHost = { crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
    postMessage(message) { messages.push(message); }, async fetch() { throw new Error("unexpected fetch"); } };
  const { prepareLinkPlan } = await import("waffle/link");
  if (!request.linkPlan) throw new Error("fixture link plan missing");
  const local = await prepareLinkPlan(request.linkPlan);
  const executor = createBunExecutor(request, host);
  let instance: WebAssembly.Instance | undefined;
  const NativeInstance = WebAssembly.Instance;
  const instantiatedModules: WebAssembly.Module[] = [];
  try {
    WebAssembly.Instance = new Proxy(NativeInstance, { construct(Target, args: ConstructorParameters<typeof WebAssembly.Instance>) {
      instantiatedModules.push(args[0]);
      return new Target(...args);
    } });
    await bootstrap(request, { ...executor,
      setup(context) { context.fs.preopen = () => 1; context.fs.retain = () => {}; context.fs.release = () => {}; },
      async instantiated(context) { instance = context.instance; await executor.instantiated?.(context); },
    }, host);
    if (!instance) throw new Error("linked core did not instantiate");
    const { value, ctors, __indirect_function_table: table } = instance.exports;
    if (typeof value !== "function" || !(ctors instanceof WebAssembly.Global) || !(table instanceof WebAssembly.Table)) throw new Error("fixture exports missing");
    expect(instantiatedModules).toHaveLength(2);
    expect(instantiatedModules[0]).toBe(local.entryModule);
    expect(instantiatedModules[0]).not.toBe(request.module);
    expect(WebAssembly.Module.exports(instantiatedModules[1]!).some(entry => entry.name === "quickjs_run")).toBe(true);
    expect(value()).toBe(42);
    expect(ctors.value).toBe(1);
    expect(table.length).toBe(2);
    expect(table.get(1)).toBeNull();
    expect(messages.some(message => message.type === "exit" && message.code === 0)).toBe(true);
    expect(messages.some(message => message.type === "error")).toBe(false);
  } finally { WebAssembly.Instance = NativeInstance; connection.client.port.close(); connection.server.port.close(); }
});
async function runSharedSetup(mode: "normal" | "send-failure" | "revoked-after-export" | "engine-failure") {
  const connection = createFilesystemConnection(), broker = createSharedObjectBroker(), route = broker.register();
  const messages: WorkerMessage[] = [];
  let exported = false, bound: SharedObjectService | undefined;
  const host: BunExecutorHost & RuntimeWorkerHost = {
    crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
    fetch: globalThis.fetch.bind(globalThis),
    postMessage(message, transfer) {
      if (message.type !== "bun-shared-connect") { messages.push(message); return; }
      exported = true;
      if (mode === "send-failure") throw new Error("native publication failed");
      expect(transfer).toEqual([message.port]);
      route.attach(message.port);
    },
  };
  const request: RunRequest = {
    engine: "browser", adapter: "bun", module: guest(1), args: ["bun"], env: {},
    filesystem: connection.client, runtimeProcess: createWorkerProcessTransport({ pid: 1, job: 1 }),
    trace: false, net: null, moduleCache: null, slots: "off", sharedObjects: { owner: route.id },
  };
  const executor = createBunExecutor(request, host);
  startEngineHost.mockImplementationOnce(async options => {
    bound = options.sharedObjects as SharedObjectService;
    expect(bound.inspect().closed).toBe(false);
    if (mode === "engine-failure") throw new Error("engine start rejected");
    return 0;
  });
  try {
    await bootstrap(request, { ...executor, setup(context) {
      context.fs.preopen = () => 1; context.fs.retain = () => {}; context.fs.release = () => {};
      executor.setup?.({ ...context, checkActive() {
        context.checkActive();
        if (mode === "revoked-after-export" && exported) throw new Error("setup revoked");
      } });
    } }, host);
    await new Promise(resolve => setTimeout(resolve, 5));
    return { messages, exported, bound, retained: broker.inspect(), afterCleanup: broker.inspect };
  } finally {
    executor.beforeFinish?.(); route.close(); broker.dispose();
    connection.client.port.close(); connection.server.port.close();
    startEngineHost.mockReset();
  }
}

test("real bootstrap exports a Bun-owned native setup port and closes engine service on finish", async () => {
  const result = await runSharedSetup("normal");
  expect(result.exported).toBe(true);
  expect(result.afterCleanup()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  expect(result.bound?.inspect()).toEqual({ buffers: 0, pending: 0, staged: 0, closed: true });
  expect(result.retained).toEqual({ clients: 0, objects: 0, waiting: 0 });
  expect(exits(result.messages)[0]?.type).toBe("exit");
});

for (const mode of ["send-failure", "revoked-after-export", "engine-failure"] as const) {
  test(`real bootstrap ${mode} cleanup releases its route without retaining backing`, async () => {
    const result = await runSharedSetup(mode);
    expect(result.exported).toBe(true);
    expect(result.afterCleanup()).toEqual({ clients: 0, objects: 0, waiting: 0 });
    expect(exits(result.messages)[0]?.type).toBe("error");
    expect(result.retained.objects).toBe(0);
    expect(result.retained.waiting).toBe(0);
    if (mode !== "send-failure") expect(result.retained.clients).toBe(0);
    if (result.bound) expect(result.bound.inspect().closed).toBe(true);
  });
}

const keepFixtureReference = () => {};

async function assertComposedCleanup(failure: "none" | "linked" | "shared" | "lookup") {
  const { quickjsPair } = await import("../../tests/package/quickjs-plan-fixture");
  const { prepareQuickjsProgram, programLinkPlan } = await import("../../src/assets");
  const { core, side } = quickjsPair();
  const module = await prepareQuickjsProgram(core, side);
  const connection = createFilesystemConnection(), lookup = new MessageChannel();
  const broker = createSharedObjectBroker(), route = broker.register();
  const request: RunRequest = { engine: "browser", adapter: "bun", module, linkPlan: programLinkPlan(module),
    args: ["bun"], env: {}, filesystem: connection.client, trace: false, net: null, moduleCache: null,
    slots: "off", sharedObjects: { owner: route.id }, lookupPort: lookup.port2 };
  const host: BunExecutorHost & RuntimeWorkerHost = { crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
    postMessage(message) { if (message.type === "bun-shared-connect") route.attach(message.port); },
    async fetch() { throw new Error("unexpected fetch"); } };
  const executor = createBunExecutor(request, host);
  const originalClose = MessagePort.prototype.close;
  const released: string[] = [];
  const expected = new Error(`${failure} cleanup failed`);
  let restoreClose = () => {};
  try {
    await bootstrap(request, { ...executor, beforeFinish() {},
      setup(context) {
        context.fs.preopen = () => 1; context.fs.retain = keepFixtureReference; context.fs.release = keepFixtureReference;
        executor.setup?.(context);
      },
    }, host);
    linkedFinishFailure = failure === "linked" ? expected : undefined;
    const close = spyOn(MessagePort.prototype, "close").mockImplementation(function(this: MessagePort) {
      const kind = this === lookup.port2 ? "lookup" : "shared";
      released.push(kind);
      originalClose.call(this);
      if (failure === kind && (kind === "shared" || released.filter(value => value === kind).length === 1)) throw expected;
    });
    restoreClose = () => close.mockRestore();
    if (failure === "none") expect(() => executor.beforeFinish?.()).not.toThrow();
    else expect(() => executor.beforeFinish?.()).toThrow(expected);
    expect(released).toEqual(["shared", "lookup", "lookup"]);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(broker.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  } finally {
    linkedFinishFailure = undefined;
    restoreClose();
    executor.beforeFinish?.();
    route.close(); broker.dispose();
    lookup.port1.close(); lookup.port2.close();
    connection.client.port.close(); connection.server.port.close();
  }
}

for (const failure of ["none", "linked", "shared", "lookup"] as const) {
  test(`composed executor releases linked, shared and both lookup owners after ${failure} failure`, () => assertComposedCleanup(failure));
}
