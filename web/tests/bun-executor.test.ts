import { afterAll, expect, mock, test } from "bun:test";
import { createFilesystemConnection } from "waffle/fs";
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
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
/** Exports memory, an empty `_start` and `bunwasm_ready` returning `ready`. */
function guest(ready: number): WebAssembly.Module {
  return new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [2, 0x60, 0, 0, 0x60, 0, 1, 0x7f]), section(3, [2, 0, 1]), section(5, [1, 0, 1]),
    section(7, [3].concat(name("memory"), [2, 0], name("_start"), [0, 0], name("bunwasm_ready"), [0, 1])),
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
]) test(`${label} never starts the browser engine host`, async () => {
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

test("engine host fetches use the worker's native fetch and stop after a fatal outcome", async () => {
  startEngineHost.mockClear();
  let signals!: ReturnType<typeof workerProcessState>["signals"];
  const fetched: string[] = [];
  startEngineHost.mockImplementationOnce(async options => {
    const fetch = options.fetch as (input: string) => Promise<Response>;
    expect(await (await fetch("https://example.test/live")).text()).toBe("ok");
    claimOutcome(signals.outcome, { kind: "signaled", code: 15 });
    expect(() => fetch("https://example.test/dead")).toThrow(DefaultSignal);
    return 0;
  });
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport({ pid: 1, job: 1 });
  signals = workerProcessState(runtimeProcess).signals;
  const messages: WorkerMessage[] = [];
  const host: BunExecutorHost & RuntimeWorkerHost = {
    crossOriginIsolated: true, location: { href: "https://example.test/worker.js" },
    postMessage(message: WorkerMessage) { messages.push(message); },
    async fetch(input) { fetched.push(String(input)); return new Response("ok"); },
  };
  const request: RunRequest = { engine: "browser", module: guest(1), args: ["bun"], env: {}, filesystem: connection.client,
    runtimeProcess, trace: false, net: null, moduleCache: null };
  try { await bootstrapBun(request, host); }
  finally { connection.client.port.close(); connection.server.port.close(); }
  expect(fetched).toEqual(["https://example.test/live"]);
  expect(readOutcome(signals.outcome)).toEqual({ kind: "signaled", code: 15, status: 143 });
  expect(exits(messages)).toEqual([{ type: "exit", code: 143, signal: 15, sleep: "atomics" }]);
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

test("without a networking ring no slots are installed", async () => {
  installed.length = 0;
  await run();
  expect(installed).toEqual([]);
});
