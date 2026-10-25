import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");
type Wait = ReturnType<typeof Atomics.waitAsync>;

function engineMethods(atomics: object) {
  const methods: unknown = runInNewContext(source.concat(`\n({
    pump: EngineHost.prototype.pump,
    wakeOnProcessChange: EngineHost.prototype.wakeOnProcessChange,
    exit: EngineHost.prototype.exit,
  });`), {
    TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask,
    SLOT_NAMES: [], Atomics: atomics,
  });
  if (typeof methods !== "object" || methods === null
    || !("pump" in methods) || typeof methods.pump !== "function"
    || !("wakeOnProcessChange" in methods) || typeof methods.wakeOnProcessChange !== "function"
    || !("exit" in methods) || typeof methods.exit !== "function") {
    throw new Error("Expected the real engine loop methods");
  }
  return { pump: methods.pump, wakeOnProcessChange: methods.wakeOnProcessChange, exit: methods.exit };
}

// Only the guest and scheduler boundary is stubbed. Atomics registrations are real.
function fixture(waitAsync = true, withWord = true) {
  const waits: Wait[] = [];
  const word = new Int32Array(new SharedArrayBuffer(4));
  const methods = engineMethods({
    load: Atomics.load,
    waitAsync: waitAsync ? (...args: Parameters<typeof Atomics.waitAsync>) => {
      const wait = Atomics.waitAsync(...args);
      waits.push(wait);
      return wait;
    } : undefined,
  });
  const delays: number[] = [];
  let finished = 0;
  function publish() {
    Atomics.add(word, 0, 1);
    return Atomics.notify(word, 0);
  }
  const host = {
    exited: false, testComplete: false, pendingAsync: 0, wakeArmed: false,
    timer: null, timerAt: Infinity,
    o: { processWake: withWord ? word : undefined, onExit(_code: number) { publish(); } },
    native: { hostCaps: { signal: true }, closeAllDirs() {} },
    internal: {
      pumpSignals() { return false; }, runTimers() { return -1; },
      ioPending() { return 1; }, pumpIo() { return false; },
    },
    pump() { Reflect.apply(methods.pump, this, []); },
    wakeOnProcessChange(observed: number) { Reflect.apply(methods.wakeOnProcessChange, this, [observed]); },
    exit(code: number) { Reflect.apply(methods.exit, this, [code]); },
    guard<T>(callback: () => T) { return callback(); },
    schedule(delay: number) { if (!this.exited) delays.push(delay); },
    flush() {}, finish() { finished++; }, resolveDone() {},
  };
  async function settle() { await Promise.all(waits.map(wait => wait.value)); }
  return {
    host, word, waits, delays, publish, settle, finished: () => finished,
    async [Symbol.asyncDispose]() {
      host.exit(0);
      publish();
      await settle();
      expect(host.wakeArmed).toBe(false);
      expect(Atomics.notify(word, 0)).toBe(0);
    },
  };
}

test("process wake arms only one waiter across unchanged fallback turns", async () => {
  await using f = fixture();
  for (let index = 0; index < 1000; index++) f.host.pump();
  expect(f.waits).toHaveLength(1);
  expect(f.host.wakeArmed).toBe(true);
  expect(f.delays).toHaveLength(1000);
  expect(f.delays.every(delay => delay === 25)).toBe(true);
  expect(f.publish()).toBe(1);
  await f.settle();
  expect(f.host.wakeArmed).toBe(false);
  expect(f.delays.at(-1)).toBe(0);
  expect(Atomics.notify(f.word, 0)).toBe(0);
});

test("process wake generation changed during readiness is not lost before subscription", async () => {
  await using f = fixture();
  f.host.internal.pumpIo = () => { f.publish(); return false; };
  f.host.pump();
  expect(f.waits).toHaveLength(1);
  expect(f.waits[0]?.async).toBe(false);
  expect(f.host.wakeArmed).toBe(false);
  expect(f.delays).toEqual([0, 25]);
});

test("process wake after subscription schedules immediately and rearms without spinning", async () => {
  await using f = fixture();
  f.host.pump();
  expect(f.waits[0]?.async).toBe(true);
  expect(f.publish()).toBe(1);
  await f.settle();
  expect(f.delays).toEqual([25, 0]);
  f.host.pump();
  expect(f.waits).toHaveLength(2);
  expect(f.waits[1]?.async).toBe(true);
  expect(f.delays).toEqual([25, 0, 25]);
});

test("process wake already published before a turn does not spin on an old generation", async () => {
  await using f = fixture();
  f.publish();
  f.host.pump();
  expect(f.waits[0]?.async).toBe(true);
  expect(f.delays).toEqual([25]);
});

test("process wake ready I/O or EOF progress uses the immediate path without a waiter", async () => {
  await using f = fixture();
  f.host.internal.pumpIo = () => true;
  f.host.pump();
  expect(f.waits).toHaveLength(0);
  expect(f.delays).toEqual([0]);
});

test("process wake terminal publication drains the waiter without scheduling after exit", async () => {
  await using f = fixture();
  f.host.pump();
  expect(f.host.wakeArmed).toBe(true);
  f.host.exit(0);
  await f.settle();
  expect(f.host.wakeArmed).toBe(false);
  expect(f.delays).toEqual([25]);
  expect(Atomics.notify(f.word, 0)).toBe(0);
  f.host.pump();
  expect(f.waits).toHaveLength(1);
  expect(f.delays).toEqual([25]);
});

test("process wake signal cancellation drains an armed waiter without another turn", async () => {
  await using f = fixture();
  f.host.pump();
  f.host.internal.pumpSignals = () => { f.host.exit(143); return false; };
  f.host.pump();
  await f.settle();
  expect(f.host.exited).toBe(true);
  expect(f.host.wakeArmed).toBe(false);
  expect(f.waits).toHaveLength(1);
  expect(f.delays).toEqual([25]);
  expect(Atomics.notify(f.word, 0)).toBe(0);
});

for (const [waitAsync, withWord] of [[false, true], [true, false]]) {
  test(`process wake fallback with waitAsync=${waitAsync} word=${withWord}`, async () => {
    await using f = fixture(waitAsync, withWord);
    f.host.pump();
    expect(f.waits).toHaveLength(0);
    expect(f.delays).toEqual([25]);
  });
}

test("process wake unreferenced I/O does not subscribe or keep the guest alive", async () => {
  await using f = fixture();
  f.host.internal.ioPending = () => 0;
  f.host.pump();
  expect(f.waits).toHaveLength(0);
  expect(f.delays).toHaveLength(0);
  expect(f.finished()).toBe(1);
});
