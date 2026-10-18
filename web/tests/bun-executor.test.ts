import { afterAll, expect, mock, test } from "bun:test";
import { createFilesystemConnection, revokeFilesystem } from "waffle/fs";
import { controlAdd, controlLoad } from "waffle/proc/control";
import { WasiExit } from "waffle/core";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { bootstrap, type RuntimeWorkerHost } from "waffle/browser/worker";
import { DefaultSignal } from "../src/default-signal";
import type { BunExecutorHost, RunRequest, WorkerMessage } from "../src/bun-executor";

// The Bun executor is Waffle's bootstrap plus Bun policy. These tests run the real bootstrap with
// an injected host and a hand-assembled guest; only the browser engine host is replaced.
const actualEngineHost = { ...await import("../src/engine-host.js") };
const actualTrampoline = { ...await import("../src/net/trampoline") };
// The guest-facing slot installation is replaced by a recorder; the executor's own wrappers are kept.
const installed: Record<string, (...args: number[]) => number>[] = [];
mock.module("../src/net/trampoline", () => ({ ...actualTrampoline,
  installHostSlotsViaImport: (_instance: unknown, impls: Record<string, (...args: number[]) => number>) => { installed.push(impls); return null; } }));
const startEngineHost = mock(async (_options: Record<string, unknown>): Promise<number> => 0);
mock.module("../src/engine-host.js", () => ({ startEngineHost }));
const { createBunExecutor } = await import("../src/bun-executor");
// Module mocks are process-wide in `bun test`: leave the real engine host for the other files.
afterAll(() => { mock.module("../src/engine-host.js", () => actualEngineHost); mock.module("../src/net/trampoline", () => actualTrampoline); });

const name = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const unsigned = (value: number): number[] => {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
};
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);
const PROCESS_IMPORTS = [
  "access_cancel", "access_start", "access_take", "default_signal", "dup", "getpid",
  "interrupted", "job_of", "kill", "kill_job", "pipe", "poll", "read", "signal", "spawn",
  "wait", "wait_job", "write",
] as const;
/** Exports memory, an empty `_start` and `bunwasm_ready` returning `ready`.
 * Imports are linked but invoked directly by the test, so their dummy Wasm type is unused. */
function guest(ready: number, imports: readonly { namespace: string; name: string }[] = []): WebAssembly.Module {
  return new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [2, 0x60, 0, 0, 0x60, 0, 1, 0x7f]),
    imports.length ? section(2, [imports.length].concat(imports.flatMap(entry => name(entry.namespace).concat(name(entry.name), [0, 0])))) : [],
    section(3, [2, 0, 1]), section(5, [1, 0, 1]),
    section(7, [3].concat(name("memory"), [2, 0], name("_start"), [0, imports.length], name("bunwasm_ready"), [0, imports.length + 1])),
    section(10, [2, 2, 0, 0x0b, 4, 0, 0x41, ready, 0x0b]),
  )));
}

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

// These tests invoke the actual linked imports. Descriptor readiness and Atomics.wait
// are observation/injection points; neither the ABI scanner nor bootstrap wait hooks
// are substituted. All process, filesystem and native-wait state is test-owned.
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
        const nativeWait = Atomics.wait;
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
              Atomics.wait = ((word: Int32Array, index: number, _expected: number) => {
                expect(word.buffer).toBe(state.wake.buffer);
                expect(word.byteOffset + index * 4).toBe(state.wake.byteOffset);
                waits++; select(); return "timed-out";
              }) as typeof Atomics.wait;
              try { if (route === "runtime_proc") call(0, 1, 1000, 128); else call(0, 128, 1, 256); }
              catch (error) { failure = error; throw error; }
              finally { Atomics.wait = nativeWait; }
              throw new Error("selected death escaped the production wait guard");
            },
          }, host);
          expect(scans).toBe(1);
          expect(waits).toBe(stage === "before" ? 0 : 1);
          expect(failure).toBeInstanceOf(terminal === "signaled" ? DefaultSignal : WasiExit);
          expect(exits(messages)).toContainEqual({ type: "exit", code: terminal === "signaled" ? 143 : terminal === "exited" ? 23 : 1,
            signal: terminal === "signaled" ? 15 : undefined, sleep: "atomics" });
        } finally { Atomics.wait = nativeWait; connection.client.port.close(); connection.server.port.close(); }
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
    const nativeWait = Atomics.wait;
    let call!: (...args: number[]) => unknown;
    let waits = 0, scans = 0;
    let result: unknown, nativeResult: unknown;
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
          Atomics.wait = ((word: Int32Array, index: number, expected: number) => {
            waits++;
            expect(word.buffer).toBe(state.wake.buffer);
            expect(word.byteOffset + index * 4).toBe(state.wake.byteOffset);
            expect(expected).toBe(original);
            expect(Atomics.load(word, index)).toBe(original + 1);
            // Calling the real native primitive proves the old snapshot refuses sleep.
            nativeResult = nativeWait(word, index, expected, 0);
            return nativeResult;
          }) as typeof Atomics.wait;
          try { result = route === "runtime_proc" ? call(0, 1, 1000, 128) : call(0, 128, 1, 256); }
          finally { Atomics.wait = nativeWait; }
          if (route !== "runtime_proc") expect(view.getUint32(256, true)).toBe(1);
          return 0;
        },
      }, host);
      expect(scans).toBe(2);
      expect(waits).toBe(1);
      expect(nativeResult).toBe("not-equal");
      expect(result).toBe(route === "runtime_proc" ? 1 : 0);
    } finally { Atomics.wait = nativeWait; connection.client.port.close(); connection.server.port.close(); }
  });
}
