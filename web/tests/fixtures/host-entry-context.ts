import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createContext, runInContext } from "node:vm";
import { createScriptEvaluation } from "../../src/script-evaluation.ts";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../../src/buffer-transfer.ts";
import { builtinsSource, engineHostSource, runInContextSource } from "./engine-host-context.ts";

// Host-originated entries on the browser engine's hook path (docs/engine-browser.md).
// Request A runs with stores S1 and S2 while request C, with only S1, resumes in the same
// microtask checkpoint; then a host entry starts request B, which sets only S1. B must read
// no S2, as under Node. Modes: `reference` runs the program under Node's AsyncLocalStorage;
// `hooks` runs it on engine-host.js's hooks, entering through the host's own scheduler, I/O
// pump, process-wake wait and idle exit; `hooks-without-root` is the same with the host's
// root entry disabled, the control that shows what the check catches.

type Observation = [site: string, s1: unknown, s2: unknown];
type Program = {
  observations: Observation[];
  overlap(entry: string): PromiseLike<unknown>;
  enter(entry: string): PromiseLike<unknown>;
  stores(): [unknown, unknown];
};
type Entry = "io" | "timer" | "wake" | "beforeExit";
const ENTRIES: Entry[] = ["io", "timer", "wake", "beforeExit"];

// One text for every mode. Awaits are written in the printer's hooked shape (vendor patch 0008);
// under Node the hooks are identities.
const PROGRAM = `(function (AsyncLocalStorage) {
  const s1 = new AsyncLocalStorage(), s2 = new AsyncLocalStorage();
  const observations = [];
  const stores = () => [s1.getStore() ?? null, s2.getStore() ?? null];
  const see = (site) => observations.push([site].concat(stores()));
  const gate = Promise.resolve();
  async function requestA(entry) {
    see(entry + ".A.enter");
    __bunwasm_resume(__bunwasm_capture(), await gate);
    see(entry + ".A.resumed");
  }
  async function requestC(entry) {
    __bunwasm_resume(__bunwasm_capture(), await gate);
    see(entry + ".C.resumed");
  }
  async function requestB(entry) {
    see(entry + ".B.enter");
    __bunwasm_resume(__bunwasm_capture(), await gate);
    see(entry + ".B.resumed");
    s2.run("B2", () => see(entry + ".B.nested"));
    see(entry + ".B.exit");
  }
  return {
    observations,
    stores,
    overlap(entry) {
      return Promise.all([s1.run("A1", () => s2.run("A2", requestA, entry)), s1.run("C1", requestC, entry)]);
    },
    enter(entry) {
      see(entry + ".entry");
      return s1.run("B1", requestB, entry);
    },
  };
})`;

const EXPECTED: Observation[] = ENTRIES.flatMap(entry => [
  [`${entry}.A.enter`, "A1", "A2"],
  [`${entry}.A.resumed`, "A1", "A2"],
  [`${entry}.C.resumed`, "C1", null],
  [`${entry}.entry`, null, null],
  [`${entry}.B.enter`, "B1", null],
  [`${entry}.B.resumed`, "B1", null],
  [`${entry}.B.nested`, "B1", "B2"],
  [`${entry}.B.exit`, "B1", null],
]);

const turn = () => new Promise(resolve => setTimeout(resolve, 0));

async function reference(): Promise<Observation[]> {
  Object.assign(globalThis, { __bunwasm_capture: () => undefined, __bunwasm_resume: (_saved: unknown, value: unknown) => value });
  // oxlint-disable-next-line no-eval -- Evaluate the shared program text as the hook modes do.
  const program: Program = (0, eval)(PROGRAM)(AsyncLocalStorage);
  const served = new Set<PromiseLike<unknown>>();
  const server = createServer((_request, response) => {
    served.add(program.enter("io"));
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const word = new Int32Array(new SharedArrayBuffer(4));
  const wake = Atomics.waitAsync(word, 0, 0);
  assert(wake.async);
  const woken = wake.value.then(() => program.enter("wake"));
  const exited = new Promise<void>(resolve => process.once("beforeExit", () => {
    void program.enter("beforeExit").then(() => resolve());
  }));

  await program.overlap("io");
  const { port } = server.address() as AddressInfo;
  await (await fetch(`http://127.0.0.1:${port}/`)).text();
  await Promise.all(served);
  await new Promise<void>(resolve => server.close(() => resolve()));

  await program.overlap("timer");
  await new Promise(resolve => setTimeout(() => resolve(program.enter("timer")), 5));

  await program.overlap("wake");
  Atomics.store(word, 0, 1);
  Atomics.notify(word, 0);
  await woken;

  await program.overlap("beforeExit");
  await exited;
  return program.observations;
}

type Loop = { io: (() => void) | null; ioWaiting: boolean; signal: (() => void) | null; beforeExit: (() => void) | null };

function hookHost(withoutRoot: boolean) {
  const loop: Loop = { io: null, ioWaiting: false, signal: null, beforeExit: null };
  let exitCode: unknown;
  let onExit: (() => void) | null = null;
  const context = createContext({
    TextEncoder, TextDecoder, URL, Blob, MessageChannel, setTimeout, clearTimeout, queueMicrotask,
    createScriptEvaluation, isWasmMemoryBuffer, transferArrayBuffers, SLOT_NAMES: [],
    memoryViews: () => ({}), loop, withoutRoot,
    exited: (code: unknown) => { exitCode = code; onExit?.(); },
  });
  // The real constructor: its MessageChannel is the scheduler's zero-delay task.
  runInContext(`${engineHostSource()}
    if (withoutRoot) EngineHost.prototype.enterRoot = function () {};
    const host = new EngineHost({ instance: { exports: {} } }, exited);
    const native = Object.assign(host.valueNatives(), { hostCaps: {}, flushOutput() {}, tlsDispose() {}, closeAllDirs() {} });
    host.native = native;
    const run = (name) => { const fn = loop[name]; loop[name] = null; if (fn) fn(); };
    const internal = {
      native, builtinFactories: {}, require: () => ({}),
      pumpSignals() { run("signal"); return false; },
      runTimers: () => -1,
      ioPending: () => (loop.io || loop.ioWaiting ? 1 : 0),
      pumpIo() { run("io"); return false; },
      emitBeforeExit() { run("beforeExit"); return false; },
      beforeExit: () => 0,
      handleUncaught: () => false,
    };
    host.internal = internal;
    ${runInContextSource()}`, context);
  runInContext(builtinsSource(), context);
  runInContext("host.installGlobals(); host.wrapPromiseJobs();", context);
  const program: Program = runInContext(`(${PROGRAM})(internal.builtinFactories["node:async_hooks"]().AsyncLocalStorage)`, context);
  const host = runInContext("host", context);
  const exit = new Promise<unknown>(resolve => { onExit = () => resolve(exitCode); });
  return { loop, program, host, exit };
}

async function hooks(withoutRoot: boolean): Promise<{ observations: Observation[]; leftovers: unknown[] }> {
  const { loop, program, host, exit } = hookHost(withoutRoot);
  // The frame the overlap leaves current once its microtasks have drained, before each entry.
  const leftovers: unknown[] = [];
  const overlap = async (entry: Entry) => {
    await program.overlap(entry);
    await turn();
    const stale: unknown[] = [entry];
    leftovers.push(stale.concat(program.stores()));
  };
  const arm = (entry: Entry, set: (fn: () => void) => void) => new Promise<unknown>(resolve => set(() => resolve(program.enter(entry))));
  // A pending network handle keeps the host loop waiting rather than exiting.
  host.pendingAsync = 1;

  // Network readiness: the zero-delay MessageChannel task pumps I/O, which runs the request handler.
  await overlap("io");
  const io = arm("io", fn => { loop.io = fn; });
  host.schedule(0);
  await io;

  // A timer-driven turn: the host's setTimeout wake, then signal handlers.
  await overlap("timer");
  const timer = arm("timer", fn => { loop.signal = fn; });
  host.schedule(5);
  await timer;

  // The process wake word: pumping with I/O pending arms Atomics.waitAsync; a change wakes the loop.
  const word = new Int32Array(new SharedArrayBuffer(4));
  host.o.processWake = word;
  loop.ioWaiting = true;
  host.schedule(0);
  await turn();
  assert.equal(host.wakeArmed, true);
  await overlap("wake");
  const wake = arm("wake", fn => { loop.io = fn; });
  loop.ioWaiting = false;
  Atomics.store(word, 0, 1);
  Atomics.notify(word, 0);
  await wake;
  host.o.processWake = undefined;

  // Idle: nothing pending, so the loop runs beforeExit listeners and then exits.
  await overlap("beforeExit");
  host.pendingAsync = 0;
  const beforeExit = arm("beforeExit", fn => { loop.beforeExit = fn; });
  host.schedule(0);
  await beforeExit;
  assert.equal(await exit, 0);
  host.channel.port1.close();
  return { observations: program.observations, leftovers };
}

const mode = process.argv[2];
if (mode === "reference") {
  const observations = await reference();
  assert.deepEqual(observations, EXPECTED);
  console.log(`HOST_ENTRY_RESULT ${JSON.stringify({ mode, observations })}`);
} else if (mode === "hooks" || mode === "hooks-without-root") {
  const { observations, leftovers } = await hooks(mode === "hooks-without-root");
  // Each overlap must leave a stale request frame for the entry to inherit, else the check proves nothing.
  assert.deepEqual(leftovers, ENTRIES.map(entry => [entry, "A1", "A2"]));
  console.log(`HOST_ENTRY_RESULT ${JSON.stringify({ mode, observations, leftovers, expected: EXPECTED })}`);
} else {
  throw new Error("mode must be reference, hooks or hooks-without-root");
}
