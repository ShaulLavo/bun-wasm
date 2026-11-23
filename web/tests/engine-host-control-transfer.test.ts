import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { RuntimeWorkerSignal } from "waffle/browser/worker";
import { memoryViews } from "waffle/core";
import { DefaultSignal } from "../src/default-signal.ts";
import { createTickScheduler } from "../src/tick-scheduler.ts";

// The released constructor is private. Use the same module as the installed bootstrap,
// rather than inventing a lookalike or loading a second copy of Waffle's source.
const { ProcessReplaced }: { ProcessReplaced: new (message: string) => Error } =
  await import(new URL("../proc/exec.js", import.meta.resolve("waffle/browser/worker")).href);

const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");
const packageSource = new Bun.Transpiler({ loader: "ts" }).transformSync("globalThis.factory = " +
  readFileSync(new URL("../../crates/bunwasm-runtime/src/js/package_scripts.ts", import.meta.url), "utf8"));

function packageEntry(control: unknown) {
  const factory = runInNewContext(packageSource);
  const spawned: unknown[] = [];
  const scripts = factory({
    native: { exists: () => true, readFileUtf8: () => '{"scripts":{"build":"echo never"}}', platformInfo: { version: "test", arch: "wasm32" },
      packageScriptsHandoff() { throw control; } },
    require(name: string) {
      if (name === "path") return path;
      if (name === "process") return { cwd: () => "/app", env: { PATH: "/bin" }, execPath: "/bin/bun", execArgv: [], stderr: { write() {} } };
      if (name === "spawn") return { spawn: (...args: unknown[]) => { spawned.push(args); } };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return { run: () => scripts.run({ kind: "script", name: "build", args: [] }), spawned };
}

function fixture(runMain: () => unknown) {
  const cleanup: string[] = [];
  const errors: unknown[] = [];
  const exits: number[] = [];
  const done = Promise.withResolvers<number>();
  const context = { TextEncoder, TextDecoder, URL, Blob, queueMicrotask, SLOT_NAMES: [], memoryViews,
    setTimeout: () => 1, clearTimeout() { cleanup.push("timer"); },
    installNativeStreamState: () => () => { cleanup.push("streams"); } };
  const { EngineHost, startEngineHost, exitSignal } = runInNewContext(source + "\n({ EngineHost, startEngineHost, exitSignal: () => new ExitSignal() });", context);
  const options = { instance: { exports: { memory: new WebAssembly.Memory({ initial: 1 }) } }, moduleUrls: "blob", onExit: (code: number) => { exits.push(code); },
    isExecutionUnwind: (error: unknown) => error instanceof ProcessReplaced || error instanceof RuntimeWorkerSignal || error instanceof DefaultSignal,
    sharedObjects: { close() { cleanup.push("shared"); } } };
  const host = new EngineHost(options, done.resolve, done.reject);
  host.entry = { kind: "script", main: "/app/build" };
  host.native = { tlsDispose() { cleanup.push("tls"); }, closeAllDirs() { cleanup.push("dirs"); }, flushOutput() { cleanup.push("flush"); } };
  host.internal = { runMain, handleUncaught(error: unknown) { errors.push(error); return false; }, workerStartup: { cancel() { cleanup.push("startup"); } } };
  host.disposeNativeStreams = context.installNativeStreamState();
  const result = done.promise.then(code => ({ code }), error => ({ error }));
  return { host, result, cleanup, errors, exits, options, EngineHost, startEngineHost, exitSignal };
}

for (const mode of ["sync", "async-package"] as const) {
  test(`${mode} replacement rejects with the original Waffle control after host cleanup`, async () => {
    const control = new ProcessReplaced("process image replaced");
    const entry = packageEntry(control);
    const f = fixture(mode === "sync" ? () => { throw control; } : entry.run);
    f.host.runEntry();
    const result = await f.result;
    expect("error" in result && result.error).toBe(control);
    expect(f.errors).toEqual([]);
    expect(f.exits).toEqual([]);
    expect(f.cleanup).toEqual(["startup", "shared", "streams", "tls", "dirs", "flush"]);
    expect(f.host.exited).toBe(true);
    expect(entry.spawned).toEqual([]);
    f.host.uncaught(new Error("late"));
    f.host.pump();
    expect(f.errors).toEqual([]);
  });
}

for (const control of [new RuntimeWorkerSignal(9), new DefaultSignal(15)]) {
  test(`${control.constructor.name} cancellation keeps its original identity`, async () => {
    const f = fixture(() => Promise.reject(control));
    f.host.runEntry();
    const result = await f.result;
    expect("error" in result && result.error).toBe(control);
    expect(f.exits).toEqual([]);
    expect(f.errors).toEqual([]);
  });
}

for (const error of [new Error("native failed"), { message: "process image replaced" }, 143]) {
  test(`ordinary throw ${String(error)} still reaches the guest error handler and exit 1`, async () => {
    const f = fixture(() => Promise.reject(error));
    f.host.runEntry();
    expect(await f.result).toEqual({ code: 1 });
    expect(f.errors).toEqual([error]);
    expect(f.exits).toEqual([1]);
  });
}

for (const code of [0, 2, 143]) {
  test(`ordinary exit ${code} resolves once and keeps cleanup`, async () => {
    const f = fixture(() => { f.host.exit(code); throw f.exitSignal(); });
    f.host.runEntry();
    expect(await f.result).toEqual({ code });
    expect(f.errors).toEqual([]);
    expect(f.exits).toEqual([code]);
    expect(f.cleanup).toEqual(["startup", "shared", "streams", "tls", "dirs", "flush"]);
    f.host.exit(1);
    expect(f.exits).toEqual([code]);
  });
}

test("setup rejection disposes installed host resources and retains the thrown identity", async () => {
  const error = new Error("setup failed");
  const f = fixture(() => {});
  f.EngineHost.prototype.start = function () { throw error; };
  await expect(f.startEngineHost(f.options)).rejects.toBe(error);
  expect(f.cleanup).toEqual(["shared", "streams"]);
  expect(f.exits).toEqual([]);
});

test("an ordinary async entry finishes successfully through the idle loop", async () => {
  const f = fixture(() => Promise.resolve());
  f.host.internal.emitBeforeExit = () => false;
  f.host.internal.beforeExit = () => 0;
  f.host.runEntry();
  await Promise.resolve();
  await Promise.resolve();
  f.host.idleWait = true;
  f.host.finish();
  expect(await f.result).toEqual({ code: 0 });
  expect(f.exits).toEqual([0]);
  expect(f.errors).toEqual([]);
});

test("failed unwind cleanup reports both errors without manufacturing an ordinary exit", async () => {
  const control = new ProcessReplaced("process image replaced");
  const cleanupError = new Error("stream cleanup failed");
  const f = fixture(() => { throw control; });
  f.host.disposeNativeStreams = () => { throw cleanupError; };
  f.host.runEntry();
  const result = await f.result;
  expect(result).toHaveProperty("error");
  if (!("error" in result)) throw new Error("Expected cleanup rejection");
  expect(result.error).toMatchObject({ errors: [control, cleanupError] });
  expect(f.exits).toEqual([]);
  expect(f.cleanup).toEqual(["startup", "shared", "tls", "dirs", "flush"]);
});

function bootstrapTimerHarness() {
  const bootstrapSource = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const start = bootstrapSource.indexOf("  function reportCallbackError(err) {");
  const end = bootstrapSource.indexOf("  internal.pendingIo = 0;", start);
  if (start < 0 || end < 0) throw new Error("Expected runTimers block in bootstrap.js");
  return bootstrapSource.slice(start, end);
}

function runImmediateUnwindFixture(
  firstCallback: (ctx: {
    internalObj: { exitStarted: boolean };
    hostNative: { exit: (code: number) => never };
  }) => void,
) {
  const f = fixture(() => {});
  const ran: string[] = [];
  const block = bootstrapTimerHarness();
  let exitedCode: number | undefined;
  const hostNative = {
    now: () => 0,
    exit(code: number): never {
      exitedCode = code;
      f.host.exit(code);
      throw f.exitSignal();
    },
    isExecutionUnwind: (error: unknown) => f.options.isExecutionUnwind(error),
  };
  const immediates: Array<{ _active: boolean; _running: boolean; _context: unknown; _callback: () => void; _args: unknown[] }> = [];
  const internalObj = {
    exitStarted: false,
    workerPump: null,
    pendingIo: 0,
    messagePortRefs: new Set(),
    handleUncaught(error: unknown) { f.errors.push(error); return true; },
    runTimers: () => -1,
  };
  runInNewContext(
    `(function(internal, native, immediates) {
      let timerPhaseEnd = null, immediateBatchRemaining = null, immediateRan = false, refedTimers = 0;
      const timerQueue = [];
      const runInContext = (_c, fn, self, args) => fn.apply(self, args);
      const runDueTimer = () => false;
      const runOneTimer = () => {};
      const loopStopped = () => false;
      ${block}
    })`,
  )(internalObj, hostNative, immediates);

  immediates.push(
    { _active: true, _running: false, _context: undefined, _callback: () => { ran.push("first"); firstCallback({ internalObj, hostNative }); }, _args: [] },
    { _active: true, _running: false, _context: undefined, _callback: () => { ran.push("second"); }, _args: [] },
  );
  f.host.internal = { ...f.host.internal, ...internalObj, pumpSignals: () => false, ioPending: () => 0, pumpIo: () => false };
  f.host.pump();
  return { f, ran, exitedCode: () => exitedCode };
}

test("returning onExit host unwinds process.exit(7) from first immediate without uncaughtException or second immediate", async () => {
  const { f, ran, exitedCode } = runImmediateUnwindFixture(({ internalObj, hostNative }) => {
    internalObj.exitStarted = true;
    hostNative.exit(7);
  });
  expect(await f.result).toEqual({ code: 7 });
  expect(exitedCode()).toBe(7);
  expect(ran).toEqual(["first"]);
  expect(f.errors).toEqual([]);
  expect(f.exits).toEqual([7]);
});

test("execution unwind inside an immediate skips uncaughtException and remaining immediates", async () => {
  const control = new ProcessReplaced("process image replaced");
  const { f, ran } = runImmediateUnwindFixture(() => { throw control; });
  const result = await f.result;
  expect("error" in result && result.error).toBe(control);
  expect(ran).toEqual(["first"]);
  expect(f.errors).toEqual([]);
  expect(f.exits).toEqual([]);
});

test("tick scheduler drains sync ticks before native await and microtask ticks after five awaits before next turn", async () => {
  const order: string[] = [];
  const queuedTicks: Array<() => void> = [];
  const channel = new MessageChannel();
  let turnScheduled = false;
  let nextTurnCallback: (() => void) | null = null;
  const done = Promise.withResolvers<void>();
  const scheduler = createTickScheduler(
    () => {
      while (queuedTicks.length > 0) queuedTicks.shift()!();
    },
    () => {
      if (turnScheduled) return;
      turnScheduled = true;
      channel.port2.postMessage(0);
    },
    queueMicrotask,
    () => false,
  );
  const enqueueTick = (fn: () => void) => {
    queuedTicks.push(fn);
    scheduler.schedule();
  };
  channel.port1.onmessage = () => {
    turnScheduled = false;
    if (scheduler.drainBeforeTurn()) {
      if (nextTurnCallback) {
        turnScheduled = true;
        channel.port2.postMessage(0);
      }
      return;
    }
    const cb = nextTurnCallback;
    nextTurnCallback = null;
    if (cb) scheduler.runTask(cb);
  };
  scheduler.runTask(() => {
    enqueueTick(() => order.push("sync-tick"));
    Promise.resolve().then(() => {
      enqueueTick(() => order.push("micro-tick"));
      void (async () => {
        await 0;
        await 0;
        await 0;
        await 0;
        await 0;
        order.push("five-awaits");
      })();
    });
    nextTurnCallback = () => {
      order.push("next-immediate");
      done.resolve();
    };
    turnScheduled = true;
    channel.port2.postMessage(0);
  });
  await done.promise;
  channel.port1.close();
  channel.port2.close();
  expect(order).toEqual(["sync-tick", "five-awaits", "micro-tick", "next-immediate"]);
});

function tickHostHarness(extraContext: Record<string, unknown> = {}) {
  const events: string[] = [];
  const ticks: Array<() => void> = [];
  const done = Promise.withResolvers<number>();
  const context = {
    TextEncoder,
    TextDecoder,
    URL,
    Blob,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    MessageChannel,
    SLOT_NAMES: [],
    memoryViews,
    createTickScheduler,
    installNativeStreamState: () => () => {},
    ...extraContext,
  };
  const { EngineHost } = runInNewContext(source + "\n({ EngineHost });", context);
  const host = new EngineHost(
    { instance: { exports: { memory: new WebAssembly.Memory({ initial: 1 }) } }, moduleUrls: "blob", onExit: () => {} },
    done.resolve,
    done.reject,
  );
  host.native = { tlsDispose() {}, closeAllDirs() {}, flushOutput() {}, hostCaps: {} };
  const baseInternal = {
    pumpSignals: () => false,
    ioPending: () => 0,
    pumpIo: () => false,
    runTicks() {
      while (ticks.length > 0) ticks.shift()!();
    },
    emitBeforeExit: () => false,
    beforeExit: () => 0,
    handleUncaught(error: unknown) {
      throw error;
    },
  };
  return { events, ticks, done, host, baseInternal };
}

test("beforeExit microtask tick drains without triggering an extra beforeExit unless it schedules loop work", async () => {
  const { events, ticks, done, host, baseInternal } = tickHostHarness();
  let beforeExitCalls = 0;
  let pendingTimer = false;
  host.internal = {
    ...baseInternal,
    runTimers() {
      if (!pendingTimer) return -1;
      pendingTimer = false;
      events.push("timer");
      return 0;
    },
    emitBeforeExit() {
      beforeExitCalls++;
      events.push(`beforeExit:${beforeExitCalls}`);
      if (beforeExitCalls === 1) {
        Promise.resolve().then(() => {
          events.push("microtask:1");
          ticks.push(() => {
            events.push("tick:1");
            pendingTimer = true;
          });
          host.ticks.schedule();
        });
        return true;
      }
      if (beforeExitCalls === 2) {
        Promise.resolve().then(() => {
          events.push("microtask:2");
          ticks.push(() => events.push("tick:2"));
          host.ticks.schedule();
        });
        return true;
      }
      return true;
    },
    beforeExit() {
      events.push("exit");
      return 0;
    },
  };
  host.schedule(0);
  expect(await done.promise).toBe(0);
  expect(events).toEqual([
    "beforeExit:1",
    "microtask:1",
    "tick:1",
    "timer",
    "beforeExit:2",
    "microtask:2",
    "tick:2",
    "exit",
  ]);
});

test("unhandledRejection pass drains queued nextTicks before follow-up microtasks on Node host", async () => {
  const hostNextTicks: Array<() => void> = [];
  const rejectionListeners: Array<(reason: unknown, promise: Promise<unknown>) => void> = [];
  const fakeProcess = {
    versions: { node: "24.0.0", bun: "1.4.4" },
    on(event: string, listener: (reason: unknown, promise: Promise<unknown>) => void) {
      if (event === "unhandledRejection") rejectionListeners.push(listener);
    },
    nextTick(callback: () => void) {
      hostNextTicks.push(callback);
    },
  };
  const { events, ticks, done, host, baseInternal } = tickHostHarness({ process: fakeProcess });
  let immediateRan = false;
  const flushHostTicks = () => {
    while (hostNextTicks.length > 0) hostNextTicks.shift()!();
  };
  const emitRejection = (reason: string) => {
    const p = Promise.resolve();
    for (const listener of rejectionListeners) listener(reason, p);
  };
  host.internal = {
    ...baseInternal,
    runTimers() {
      if (immediateRan) return -1;
      immediateRan = true;
      events.push("immediate");
      return -1;
    },
    handleRejection(reason: unknown) {
      events.push(`rejection:${String(reason)}`);
      ticks.push(() => events.push(`tick:${String(reason)}`));
      host.ticks.schedule();
      Promise.resolve().then(() => {
        events.push(`micro:${String(reason)}`);
        if (reason === "r2") {
          Promise.resolve().then(() => {
            emitRejection("from micro");
            flushHostTicks();
          });
        }
      });
      return true;
    },
    runMain() {
      host.schedule(0);
    },
  };
  host.entry = { kind: "script", main: "/app/index.ts" };
  host.watchRejections();
  host.runEntry();
  emitRejection("r1");
  emitRejection("r2");
  flushHostTicks();
  expect(await done.promise).toBe(0);
  expect(events).toEqual([
    "rejection:r1",
    "rejection:r2",
    "tick:r1",
    "tick:r2",
    "micro:r1",
    "micro:r2",
    "rejection:from micro",
    "tick:from micro",
    "micro:from micro",
    "immediate",
  ]);
});

test("unhandledrejection event drains queued nextTicks before follow-up microtasks on Browser host", async () => {
  const listeners = new Map<string, Array<(event: { preventDefault(): void; reason?: unknown; promise?: unknown }) => void>>();
  const { events, ticks, done, host, baseInternal } = tickHostHarness({
    addEventListener(type: string, listener: (event: { preventDefault(): void; reason?: unknown; promise?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  });
  let immediateRan = false;
  host.internal = {
    ...baseInternal,
    runTimers() {
      if (immediateRan) return -1;
      immediateRan = true;
      events.push("immediate");
      return -1;
    },
    handleRejection(reason: unknown) {
      events.push(`rejection:${String(reason)}`);
      ticks.push(() => events.push(`tick:${String(reason)}`));
      host.ticks.schedule();
      Promise.resolve().then(() => events.push(`micro:${String(reason)}`));
      return true;
    },
    runMain() {
      host.schedule(0);
    },
  };
  host.entry = { kind: "script", main: "/app/index.ts" };
  host.watchRejections();
  host.runEntry();
  for (const listener of listeners.get("unhandledrejection") ?? []) {
    listener({ preventDefault() {}, reason: "r1", promise: Promise.resolve() });
  }
  expect(await done.promise).toBe(0);
  expect(events).toEqual([
    "rejection:r1",
    "tick:r1",
    "micro:r1",
    "immediate",
  ]);
});

test("native.gc() schedules one unref'd post-turn collection and cancels it on exit", () => {
  const scheduled: Array<{ fn: () => void; ms: number; unrefd: boolean; cleared: boolean }> = [];
  const context = {
    TextEncoder,
    TextDecoder,
    URL,
    Blob,
    queueMicrotask,
    SLOT_NAMES: [],
    memoryViews,
    createScriptEvaluation: () => ({}),
    createTickScheduler,
    transferArrayBuffers: () => {},
    isWasmMemoryBuffer: () => false,
    installNativeStreamState: () => () => {},
    setTimeout(fn: () => void, ms: number) {
      const entry = { fn, ms, unrefd: false, cleared: false };
      scheduled.push(entry);
      return {
        entry,
        unref() {
          entry.unrefd = true;
        },
      };
    },
    clearTimeout(handle: { entry?: { cleared: boolean } }) {
      if (handle?.entry) handle.entry.cleared = true;
    },
  };
  const { EngineHost } = runInNewContext(source + "\n({ EngineHost });", context);
  let gcCalls = 0;
  const done = Promise.withResolvers<number>();
  const host = new EngineHost(
    {
      instance: { exports: { memory: new WebAssembly.Memory({ initial: 1 }) } },
      moduleUrls: "blob",
      onExit: () => {},
      gc: () => { gcCalls++; },
      yieldAfterGc: true,
    },
    done.resolve,
    done.reject,
  );
  host.native = { tlsDispose() {}, closeAllDirs() {}, flushOutput() {}, hostCaps: {} };
  const natives = host.valueNatives(() => undefined);

  natives.gc();
  natives.gc();
  expect(gcCalls).toBe(2);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.ms).toBe(0);
  expect(scheduled[0]!.unrefd).toBe(true);

  scheduled[0]!.fn();
  expect(gcCalls).toBe(3);

  natives.gc();
  expect(scheduled).toHaveLength(2);
  host.exit(0);
  expect(scheduled[1]!.cleared).toBe(true);
  scheduled[1]!.fn();
  expect(gcCalls).toBe(4);
});

test("native.gc() collects WeakRef targets dereferenced in the same turn before a subsequent setTimeout", () => {
  const engineHostUrl = new URL("../src/engine-host.js", import.meta.url).href;
  const script = `
    import { readFileSync } from "node:fs";
    import { runInNewContext } from "node:vm";
    const src = readFileSync(new URL(${JSON.stringify(engineHostUrl)}), "utf8")
      .replace(/^import .*;\\n/gm, "")
      .replace("export function startEngineHost", "function startEngineHost");
    const { EngineHost } = runInNewContext(src + "\\n({ EngineHost });", {
      TextEncoder, TextDecoder, URL, Blob, queueMicrotask, setTimeout, clearTimeout, MessageChannel,
      SLOT_NAMES: [],
      memoryViews: () => ({ bytes: () => new Uint8Array(), view: () => new DataView(new ArrayBuffer(0)) }),
      createScriptEvaluation: () => ({}),
      createTickScheduler: () => ({ queued: false, schedule() {}, runTask: fn => fn(), runRejectionCallback: fn => fn(), drainBeforeTurn: () => false, drainNow() {}, reset() {} }),
      transferArrayBuffers: () => {},
      isWasmMemoryBuffer: () => false,
      installNativeStreamState: () => () => {},
    });
    const host = new EngineHost(
      {
        instance: { exports: { memory: new WebAssembly.Memory({ initial: 1 }) } },
        moduleUrls: "data",
        onExit: () => {},
        gc: globalThis.__bunwasm_v8_gc.bind(globalThis),
        yieldAfterGc: true,
      },
      () => {},
      () => {},
    );
    const natives = host.valueNatives(() => undefined);
    const refs = [];
    for (let i = 0; i < 20; i++) {
      let obj = { payload: new Uint8Array(64 * 1024) };
      refs.push(new WeakRef(obj));
      obj = null;
    }
    const alive = () => refs.filter(r => r.deref() !== undefined).length;
    for (let i = 0; i < 10 && alive() > 0; i++) {
      natives.gc();
      await new Promise(r => setTimeout(r, 10));
    }
    host.channel?.port1.close();
    host.channel?.port2.close();
    console.log(JSON.stringify({ alive: alive() }));
  `;
  const run = Bun.spawnSync(["node", "--expose-gc-as=__bunwasm_v8_gc", "--input-type=module", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(JSON.parse(run.stdout.toString().trim())).toEqual({ alive: 0 });
});
