import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { join } from "node:path";

const sources = join(import.meta.dir, "../crates/bunwasm-runtime/src/js");

function runtime(pending: number[], reject: Record<number, number> = {}, guestEvents = false) {
  let dequeues = 0;
  const internal: any = {
    native: {
      platformInfo: {}, env: () => ({}), argv: () => [],
      hostSignal(signal: number, mode: number) {
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
  return { internal, process, dequeues: () => dequeues };
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
