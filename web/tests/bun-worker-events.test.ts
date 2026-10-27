import { afterAll, expect, mock, test } from "bun:test";
import { bootstrap, type RuntimeWorkerHost, type WorkerSetupContext } from "waffle/browser/worker";
import { createFilesystemConnection } from "waffle/fs";
import { readOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { DefaultSignal } from "../src/default-signal";
import type { BunExecutorHost, RunRequest, WorkerMessage } from "../src/bun-executor";

// Keep the bootstrap and Bun's signal policy real; only replace the browser engine boundary.
const actualEngineHost = { ...await import("../src/engine-host.js") };
const startEngineHost = mock(async (_options: Record<string, unknown>): Promise<number> => 0);
mock.module("../src/engine-host.js", () => ({ startEngineHost }));
const { createBunExecutor } = await import("../src/bun-executor");
afterAll(() => { mock.module("../src/engine-host.js", () => actualEngineHost); });

// Original guest: memory, an empty _start and bunwasm_ready returning 1.
const name = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
const guest = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
  section(1, [2, 0x60, 0, 0, 0x60, 0, 1, 0x7f]), section(3, [2, 0, 1]), section(5, [1, 0, 1]),
  section(7, [3].concat(name("memory"), [2, 0], name("_start"), [0, 0], name("bunwasm_ready"), [0, 1])),
  section(10, [2, 2, 0, 0x0b, 4, 0, 0x41, 1, 0x0b]),
)));

function terminalEvent(type: "error" | "unhandledrejection", error: unknown): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, type === "error" ? "error" : "reason", { value: error });
  return event;
}

for (const type of ["error", "unhandledrejection"] as const) {
  test(`asynchronous Bun DefaultSignal on worker ${type} is prevented and completes once with its signal`, async () => {
    const connection = createFilesystemConnection();
    const runtimeProcess = createWorkerProcessTransport({ pid: 1, job: 1 });
    const outcome = workerProcessState(runtimeProcess).signals.outcome;
    const messages: WorkerMessage[] = [];
    const events = new EventTarget();
    const host: BunExecutorHost & RuntimeWorkerHost = {
      crossOriginIsolated: true,
      location: { href: "https://example.test/worker.js" },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      postMessage(message: WorkerMessage) { messages.push(message); },
      async fetch() { throw new Error("unexpected fetch"); },
    };
    const request: RunRequest = {
      engine: "browser", module: guest, args: ["bun"], env: {}, filesystem: connection.client,
      runtimeProcess, trace: false, net: null, moduleCache: null, slots: "off",
    };
    let context!: WorkerSetupContext<RunRequest>;
    const completions = () => messages.filter(message => message.type === "exit" || message.type === "error");
    let before: ReturnType<typeof completions> | undefined;
    let during: ReturnType<typeof completions> | undefined;
    let fatal: unknown;
    let event: Event | undefined;
    let dispatched: boolean | undefined;
    startEngineHost.mockClear();
    startEngineHost.mockImplementationOnce(async options => {
      // Dispatch only after run() has yielded, while bootstrap awaits the engine's completion.
      await Promise.resolve();
      before = completions();
      try { context.defaultSignal(13); }
      catch (error) { fatal = error; }
      event = terminalEvent(type, fatal);
      dispatched = events.dispatchEvent(event);
      during = completions();
      (options.onExit as (code: number) => void)(0);
      return 0;
    });
    const executor = createBunExecutor(request, host);
    try {
      await bootstrap(request, { ...executor, setup(value) {
        context = value;
        // No service shares this thread; the tiny guest does not make filesystem calls.
        value.fs.preopen = () => 1;
        value.fs.retain = () => {};
        value.fs.release = () => {};
        executor.setup?.(value);
      } }, host);
      // Assert outside the engine callback: bootstrap deliberately catches guest failures.
      expect(startEngineHost).toHaveBeenCalledTimes(1);
      expect(before).toEqual([]);
      expect(fatal).toBeInstanceOf(DefaultSignal);
      expect((fatal as DefaultSignal).signal).toBe(13);
      expect(dispatched).toBe(false);
      expect(event?.defaultPrevented).toBe(true);
      // The event handler must finish now, not merely wait for the engine's later return.
      expect(during).toEqual([{ type: "exit", code: 141, signal: 13, sleep: "atomics" }]);
      expect(readOutcome(outcome)).toEqual({ kind: "signaled", code: 13, status: 141 });
      expect(completions()).toEqual([{ type: "exit", code: 141, signal: 13, sleep: "atomics" }]);
      // Bootstrap removes its worker listeners when the engine completes.
      const late = terminalEvent(type, new DefaultSignal(15));
      expect(events.dispatchEvent(late)).toBe(true);
      expect(late.defaultPrevented).toBe(false);
      expect(completions()).toHaveLength(1);
    } finally {
      connection.client.port.close();
      connection.server.port.close();
    }
  });
}
