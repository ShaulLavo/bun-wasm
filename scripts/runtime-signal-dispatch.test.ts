import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { join } from "node:path";

const sources = join(import.meta.dir, "../crates/bunwasm-runtime/src/js");

function runtime(pending: number[], reject: Record<number, number> = {}, guestEvents = false) {
  let dequeues = 0;
  const signals: [number, number][] = [];
  const internal: any = {
    native: {
      platformInfo: {}, env: () => ({}), argv: () => [],
      hostSignal(signal: number, mode: number) {
        signals.push([signal, mode]);
        if (signal in reject) return reject[signal];
        if (signal !== 0 || mode !== 0) return 0;
        dequeues++;
        return pending.shift() ?? 0;
      },
    },
    require(name: string) {
      if (name === "events" && !guestEvents) return EventEmitter;
      const ts = join(sources, `${name}.ts`);
      const source = readFileSync(existsSync(ts) ? ts : join(sources, `${name}.js`), "utf8");
      return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`))(internal);
    },
  };
  const process = internal.require("process");
  return { internal, process, signals, dequeues: () => dequeues };
}

test("every signal pump serializes handlers, including a nested broken-pipe pump", () => {
  const { internal, process, dequeues } = runtime([2, 15]);
  const calls: string[] = [];
  process.on("SIGINT", () => {
    calls.push("first-start");
    expect(internal.pumpSignals()).toBe(false);
    calls.push("first-end");
  });
  process.on("SIGTERM", () => calls.push("second-handler"));
  expect(internal.pumpSignals()).toBe(true);
  expect(calls).toEqual(["first-start", "first-end", "second-handler"]);
  expect(dequeues()).toBe(3);
});

test("ordinary event-loop pump still dequeues and consumes once before callback", () => {
  const { internal, process, dequeues } = runtime([2]);
  const calls: string[] = [];
  process.once("SIGINT", () => {
    expect(process.listenerCount("SIGINT")).toBe(0);
    calls.push("handled");
  });
  expect(internal.pumpSignals()).toBe(true);
  expect(internal.pumpSignals()).toBe(false);
  expect(calls).toEqual(["handled"]);
  expect(dequeues()).toBe(3);
});

test("throwing handler propagates to the runtime's ordinary uncaught-error path", () => {
  const { internal, process } = runtime([2, 15]);
  const expected = new Error("signal callback");
  process.on("SIGINT", () => { throw expected; });
  const calls: string[] = [];
  process.on("SIGTERM", () => calls.push("after-error"));
  expect(() => internal.pumpSignals()).toThrow(expected);
  expect(internal.pumpSignals()).toBe(true);
  expect(calls).toEqual(["after-error"]);
});

test("registration and self-kill failures carry the canonical WASI errno as Node errors", () => {
  const { internal, process } = runtime([], { 1: -58, 2: -28, 19: -58, 32: -28, 15: -5 });
  const failure = (run: () => void) => { try { run(); } catch (error) { return error; } };
  expect(failure(() => { process.on("SIGHUP", () => {}); internal.listenerChanged(process, "SIGHUP"); })).toMatchObject({ code: "ENOTSUP", errno: -95, syscall: "uv_signal_start", message: "uv_signal_start ENOTSUP" });
  expect(failure(() => { process.on("SIGINT", () => {}); internal.listenerChanged(process, "SIGINT"); })).toMatchObject({ code: "EINVAL", errno: -22, syscall: "uv_signal_start" });
  expect(failure(() => process.kill(process.pid, 32))).toMatchObject({ code: "EINVAL", errno: -22, syscall: "kill", message: "kill EINVAL" });
  expect(failure(() => process.kill(process.pid, 19))).toMatchObject({ code: "ENOTSUP", errno: -95, syscall: "kill" });
  // Any other negative result is an I/O failure, never a generic message.
  expect(failure(() => process.kill(process.pid, 15))).toMatchObject({ code: "EIO", syscall: "kill" });
});

test("a rejected signal registration leaves no listener and no disposition change", () => {
  const { internal, process } = runtime([], { 1: -58, 2: -28 }, true);
  const calls: [number, number][] = [];
  const original = internal.native.hostSignal;
  internal.native.hostSignal = (signal: number, mode: number) => { calls.push([signal, mode]); return original(signal, mode); };
  const ok = () => {};
  process.on("SIGTERM", ok);
  expect(calls).toEqual([[15, 2]]);
  const failure = (run: () => void) => { try { run(); } catch (error) { return error as { code: string }; } };
  const adders: [string, (name: string, listener: () => void) => void][] = [
    ["on", (name, listener) => process.on(name, listener)],
    ["addListener", (name, listener) => process.addListener(name, listener)],
    ["once", (name, listener) => process.once(name, listener)],
    ["prependListener", (name, listener) => process.prependListener(name, listener)],
    ["prependOnceListener", (name, listener) => process.prependOnceListener(name, listener)],
  ];
  for (const [, add] of adders) {
    // First listener of an event: the event must not exist afterwards.
    expect(failure(() => add("SIGHUP", () => {}))?.code).toBe("ENOTSUP");
    expect(process.listenerCount("SIGHUP")).toBe(0);
    expect(process.eventNames()).not.toContain("SIGHUP");
  }
  expect(failure(() => process.on("SIGINT", ok))?.code).toBe("EINVAL");
  expect(process.listenerCount("SIGINT")).toBe(0);
  expect(process.listenerCount("SIGTERM")).toBe(1);
  expect(process.eventNames()).toEqual(["SIGTERM"]);
  // The rejected registrations changed no disposition: SIGTERM's was the only one published.
  expect(calls.filter(([, mode]) => mode === 2).map(([signal]) => signal).sort()).toEqual([1, 1, 1, 1, 1, 15, 2]);
});

test("a failing publication restores single and multiple listener states exactly", () => {
  const { internal, process } = runtime([], {}, true);
  let reject = false;
  const publish = internal.listenerChanged;
  internal.listenerChanged = (target: unknown, name?: string) => {
    if (reject && name === "boom") throw new Error("rejected");
    return publish(target, name);
  };
  const first = () => {}, second = () => {}, third = () => {};
  const adders = [
    (listener: () => void) => process.on("boom", listener),
    (listener: () => void) => process.once("boom", listener),
    (listener: () => void) => process.prependListener("boom", listener),
    (listener: () => void) => process.prependOnceListener("boom", listener),
  ];
  for (const add of adders) {
    reject = false;
    process.removeAllListeners("boom");
    reject = true;
    expect(() => add(third)).toThrow("rejected"); // no previous listener
    expect(process.listeners("boom")).toEqual([]);
    expect(process.eventNames()).not.toContain("boom");
    reject = false;
    process.on("boom", first);
    reject = true;
    expect(() => add(third)).toThrow("rejected"); // one previous listener (function state)
    expect(process.listeners("boom")).toEqual([first]);
    reject = false;
    process.on("boom", second);
    reject = true;
    expect(() => add(third)).toThrow("rejected"); // several previous listeners (array state)
    expect(process.listeners("boom")).toEqual([first, second]);
    expect(process.listenerCount("boom")).toBe(2);
  }
});

// Linux os.constants.signals in Node 26.7 and Bun 1.4.2. Node accepts the two
// exposed aliases too; neither accepts SIGCLD, SIGUNUSED or realtime spellings.
const namedSignals: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18,
  SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
  SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29,
  SIGPWR: 30, SIGSYS: 31,
};

test("every standard signal name and accepted alias reaches its canonical number", () => {
  const { process, signals } = runtime([], {}, true);
  for (const [name, number] of Object.entries(namedSignals)) {
    expect(process.kill(process.pid, name)).toBe(true);
    expect(signals.at(-1)).toEqual([number, 3]);
    expect(process.kill(process.pid, name.toLowerCase())).toBe(true);
    expect(signals.at(-1)).toEqual([number, 3]);
  }
});

test("all supported named listeners publish handlers and dispatch their own event once", () => {
  for (const [name, number] of Object.entries(namedSignals)) {
    if (number === 9 || (number >= 19 && number <= 22)) continue;
    const { internal, process, signals } = runtime([number], {}, true);
    const calls: string[] = [];
    process.on(name, (signal: string) => calls.push(signal));
    expect(signals).toContainEqual([number, 2]);
    expect(internal.pumpSignals()).toBe(true);
    expect(calls).toEqual([name]);
    process.removeAllListeners(name);
    expect(signals.at(-1)).toEqual([number, 0]);
  }
});

test("default-ignored and fatal signals use the registered guest handlers", () => {
  const { internal, process, signals } = runtime([17, 28, 11], {}, true);
  const calls: string[] = [];
  for (const name of ["SIGCHLD", "SIGWINCH", "SIGSEGV"]) {
    process.once(name, (signal: string) => calls.push(signal));
  }
  expect(signals).toEqual([[13, 1], [17, 2], [28, 2], [11, 2]]);
  expect(internal.pumpSignals()).toBe(true);
  expect(calls).toEqual(["SIGCHLD", "SIGWINCH", "SIGSEGV"]);
  expect(process.eventNames()).toEqual([]);
  for (const number of [17, 28, 11]) expect(signals).toContainEqual([number, 0]);
});

test("alias listeners share one disposition without losing or duplicating events", () => {
  for (const [canonical, alias, number] of [["SIGABRT", "SIGIOT", 6], ["SIGIO", "SIGPOLL", 29]] as const) {
    const { internal, process, signals } = runtime([number], {}, true);
    const calls: string[] = [];
    const first = (name: string) => calls.push(name);
    process.on(canonical, first);
    process.once(alias, (name: string) => calls.push(name));
    expect(signals).toEqual([[13, 1], [number, 2]]);
    expect(internal.pumpSignals()).toBe(true);
    expect(calls).toEqual([canonical, alias]);
    expect(signals.filter(([signal, mode]) => signal === number && mode === 0)).toEqual([]);
    expect(process.listenerCount(canonical)).toBe(1);
    expect(process.listenerCount(alias)).toBe(0);
    process.removeListener(canonical, first);
    expect(signals.at(-1)).toEqual([number, 0]);
    process.on(alias, first);
    process.on(canonical, first);
    process.removeAllListeners();
    expect(process.eventNames()).toEqual([]);
    expect(signals.filter(([signal, mode]) => signal === number && mode === 0)).toEqual([[number, 0], [number, 0]]);
  }
});

test("unsupported stop registrations roll back every guest EventEmitter adder", () => {
  const { process, signals } = runtime([], { 19: -58, 20: -58, 21: -58, 22: -58 }, true);
  process.on("ordinary", () => {});
  for (const name of ["SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU"]) {
    for (const method of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
      let error: unknown;
      try { process[method](name, () => {}); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "ENOTSUP", errno: -95, syscall: "uv_signal_start", message: "uv_signal_start ENOTSUP" });
      expect(process.listenerCount(name)).toBe(0);
      expect(process.eventNames()).toEqual(["ordinary"]);
    }
    let error: unknown;
    try { process.kill(process.pid, name); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "ENOTSUP", errno: -95, syscall: "kill" });
    expect(signals.at(-1)).toEqual([namedSignals[name], 3]);
  }
  process.removeAllListeners();
  expect(process.eventNames()).toEqual([]);
  expect(signals.filter(([, mode]) => mode === 0)).toEqual([]);
});

test("numeric bounds and unsupported names retain their existing validation", () => {
  const { process, signals } = runtime([], { 32: -28, 33: -28 }, true);
  for (const number of Array.from({ length: 64 }, (_, index) => index + 1)) {
    if (number === 32 || number === 33) {
      let error: unknown;
      try { process.kill(process.pid, number); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "EINVAL", errno: -22, syscall: "kill" });
    } else {
      expect(process.kill(process.pid, number)).toBe(true);
    }
    expect(signals.at(-1)).toEqual([number, 3]);
  }
  const beforeProbe = signals.length;
  expect(process.kill(process.pid, 0)).toBe(true);
  expect(signals.length).toBe(beforeProbe);
  for (const value of [-1, 65, 1.5, NaN, Infinity, "SIGUNKNOWN", "SIGCLD", "SIGUNUSED", "SIGRTMIN", "SIGRTMAX", "34"]) {
    expect(() => process.kill(process.pid, value)).toThrow("Unknown signal:");
    expect(signals.length).toBe(beforeProbe);
  }
  process.on("SIGUNKNOWN", () => {});
  expect(signals.length).toBe(beforeProbe);
});

test("a prepended once alias keeps handling after its canonical listener is removed", () => {
  for (const [canonical, alias, number] of [["SIGABRT", "SIGIOT", 6], ["SIGIO", "SIGPOLL", 29]] as const) {
    const { internal, process, signals } = runtime([number], {}, true);
    const calls: string[] = [];
    const listener = (name: string) => calls.push(name);
    process.on(canonical, listener);
    process.prependOnceListener(alias, listener);
    process.removeListener(canonical, listener);
    expect(signals).toEqual([[13, 1], [number, 2]]);
    expect(internal.pumpSignals()).toBe(true);
    expect(calls).toEqual([alias]);
    expect(process.eventNames()).toEqual([]);
    expect(signals.filter(([signal, mode]) => signal === number && mode === 0)).toEqual([[number, 0]]);
  }
});
