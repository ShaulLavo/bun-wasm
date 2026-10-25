import { afterEach, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as realTimers from "node:timers";
import assert from "node:assert/strict";

interface Options { signal?: AbortSignal; ref?: boolean }
interface Timer { unref(): void }
interface TimerApi {
  setTimeout(callback: () => void, delay?: number): Timer;
  clearTimeout(handle: Timer): void;
  setImmediate(callback: () => void): Timer;
  clearImmediate(handle: Timer): void;
}
interface Promises {
  setTimeout<T>(delay?: number, value?: T, options?: Options): Promise<T>;
  setImmediate<T>(value?: T, options?: Options): Promise<T>;
  setInterval<T>(delay?: number, value?: T, options?: Options): AsyncGenerator<T, unknown, unknown>;
}
const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
function load(name: string) {
  const source = readFileSync(new URL(name, directory), "utf8");
  const emitted = name.endsWith(".ts") ? new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`) : source;
  return runInNewContext(emitted);
}
function adapter(timers: TimerApi): Promises {
  const factories: Record<string, () => Promises> = {};
  load("builtins.js")({
    timers, native: {}, builtinFactories: factories,
    require(name: string) { return load(`${name}.ts`)({ timers }); },
  });
  const factory = factories["node:timers/promises"];
  if (!factory) throw new Error("Missing timers builtin");
  return factory();
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function controlled(fail?: "schedule" | "unref") {
  const active = new Map<Timer, () => void>();
  const unrefed: Timer[] = [];
  function schedule(callback: () => void) {
    if (fail === "schedule") throw new Error("schedule failed");
    const timer = { unref() { if (fail === "unref") throw new Error("unref failed"); unrefed.push(timer); } };
    active.set(timer, callback);
    return timer;
  }
  const promises = adapter({
    setTimeout: schedule, setImmediate: schedule,
    clearTimeout: timer => { active.delete(timer); },
    clearImmediate: timer => { active.delete(timer); },
  });
  function fire() {
    const [entry] = active;
    if (!entry) throw new Error("No scheduled timer");
    active.delete(entry[0]);
    entry[1]();
  }
  cleanups.push(() => active.clear());
  return { promises, active, unrefed, fire };
}
function controller() {
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  return abort;
}
function abortFailure(reason: unknown) { return { name: "AbortError", code: "ABORT_ERR", cause: reason }; }

for (const kind of ["timeout", "immediate"] as const) {
  test(`${kind} success removes listeners on a reused signal`, async () => {
    const state = controlled(), abort = controller();
    for (let index = 0; index < 7; index++) {
      const promise = kind === "timeout" ? state.promises.setTimeout(1, index, { signal: abort.signal }) : state.promises.setImmediate(index, { signal: abort.signal });
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(1);
      state.fire();
      expect(await promise).toBe(index);
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    }
    abort.abort("after success");
    expect(state.active.size).toBe(0);
  });

  test(`${kind} abort rejects with cause and removes its timer and listener`, async () => {
    const state = controlled(), abort = controller();
    const promise = kind === "timeout" ? state.promises.setTimeout(1, "tick", { signal: abort.signal }) : state.promises.setImmediate("tick", { signal: abort.signal });
    const failure = promise.catch(error => error);
    abort.abort("cancel");
    expect(await failure).toMatchObject(abortFailure("cancel"));
    expect(state.active.size).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });
}

test("already-aborted intervals do not schedule and reject once", async () => {
  const state = controlled(), abort = controller();
  abort.abort("early");
  const iterator = state.promises.setInterval(1, "tick", { signal: abort.signal });
  const pending = iterator.next();
  expect(state.active.size).toBe(0);
  await expect(pending).rejects.toMatchObject(abortFailure("early"));
  expect((await iterator.next()).done).toBe(true);
});

test("interval abort between ticks prevents any next value", async () => {
  const state = controlled(), abort = controller();
  const iterator = state.promises.setInterval(1, "tick", { signal: abort.signal });
  const first = iterator.next();
  state.fire();
  expect(await first).toEqual({ value: "tick", done: false });
  abort.abort("between");
  const next = iterator.next();
  expect(state.active.size).toBe(0);
  await expect(next).rejects.toMatchObject(abortFailure("between"));
  expect((await iterator.next()).done).toBe(true);
});

test("interval abort cancels a pending tick and all queued next calls", async () => {
  const state = controlled(), abort = controller();
  const iterator = state.promises.setInterval(1, "tick", { signal: abort.signal });
  const pending = iterator.next(), queued = iterator.next();
  const failure = pending.catch(error => error);
  abort.abort("pending");
  expect(state.active.size).toBe(0);
  expect(await failure).toMatchObject(abortFailure("pending"));
  expect((await queued).done).toBe(true);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});

test("return cancels a pending delay without yielding or leaving a queued tick", async () => {
  const state = controlled(), abort = controller();
  const iterator = state.promises.setInterval(10000, "tick", { signal: abort.signal });
  const pending = iterator.next(), queued = iterator.next();
  const returned = iterator.return("closed");
  expect(state.active.size).toBe(0);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  expect((await pending).done).toBe(true);
  expect((await queued).done).toBe(true);
  expect(await returned).toEqual({ value: "closed", done: true });
});

test("throw cancels a pending delay and rejects the explicit throw", async () => {
  const state = controlled(), abort = controller();
  const iterator = state.promises.setInterval(10000, "tick", { signal: abort.signal });
  const pending = iterator.next();
  const error = new Error("stop");
  const thrown = iterator.throw(error).catch(error => error);
  expect(state.active.size).toBe(0);
  expect((await pending).done).toBe(true);
  expect(await thrown).toBe(error);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});

test("for-await break releases the signal and schedules no extra tick", async () => {
  const state = controlled(), abort = controller();
  const values: string[] = [];
  const consume = async () => {
    for await (const value of state.promises.setInterval(1, "tick", { signal: abort.signal })) { values.push(value); break; }
  };
  const done = consume();
  state.fire();
  await done;
  expect(values).toEqual(["tick"]);
  expect(state.active.size).toBe(0);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});

test("interval forwards ref:false for each wait without unrefing the default", async () => {
  const state = controlled();
  const iterator = state.promises.setInterval(1, "tick", { ref: false });
  for (let index = 0; index < 2; index++) {
    const pending = iterator.next();
    expect(state.unrefed).toHaveLength(index + 1);
    state.fire();
    expect((await pending).value).toBe("tick");
  }
  await iterator.return(undefined);
  const ordinary = state.promises.setTimeout(1);
  state.fire();
  await ordinary;
  expect(state.unrefed).toHaveLength(2);
});

for (const fail of ["schedule", "unref"] as const) {
  test(`${fail} failure removes the listener and any scheduled handle`, async () => {
    const state = controlled(fail), abort = controller();
    await expect(state.promises.setTimeout(1, "value", { signal: abort.signal, ref: false })).rejects.toThrow(`${fail} failed`);
    expect(state.active.size).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });
}


test("abort after the timer fires but before delivery cannot yield another value", async () => {
  const state = controlled(), abort = controller();
  const iterator = state.promises.setInterval(1, "tick", { signal: abort.signal });
  const pending = iterator.next();
  const failure = pending.catch(error => error);
  state.fire();
  abort.abort("before delivery");
  expect(await failure).toMatchObject(abortFailure("before delivery"));
  expect(state.active.size).toBe(0);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});

function nativeScheduling() {
  const cancellations = new WeakMap<Timer, () => void>();
  function timeout(callback: () => void, ms?: number) {
    const handle = realTimers.setTimeout(callback, ms);
    const cancel = () => realTimers.clearTimeout(handle);
    cancellations.set(handle, cancel);
    cleanups.push(cancel);
    return handle;
  }
  function immediate(callback: () => void) {
    const handle = realTimers.setImmediate(callback);
    const cancel = () => realTimers.clearImmediate(handle);
    cancellations.set(handle, cancel);
    cleanups.push(cancel);
    return handle;
  }
  const clear = (handle: Timer) => cancellations.get(handle)?.();
  return adapter({ setTimeout: timeout, clearTimeout: clear, setImmediate: immediate, clearImmediate: clear });
}

test("the builtin factory also cleans up under native scheduling and real signals", async () => {
  const promises = nativeScheduling(), abort = controller();
  for (let index = 0; index < 7; index++) {
    expect(await promises.setTimeout(1, index, { signal: abort.signal })).toBe(index);
    expect(await promises.setImmediate(index, { signal: abort.signal })).toBe(index);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  }
  const iterator = promises.setInterval(1, "tick", { signal: abort.signal });
  cleanups.push(() => { void iterator.return(undefined); });
  expect((await iterator.next()).value).toBe("tick");
  abort.abort("real signal");
  await expect(iterator.next()).rejects.toMatchObject(abortFailure("real signal"));
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});


for (const kind of ["timeout", "immediate"] as const) {
  test(`${kind} with an already-aborted signal never schedules`, async () => {
    const state = controlled(), abort = controller();
    abort.abort("already");
    const pending = kind === "timeout" ? state.promises.setTimeout(1, "tick", { signal: abort.signal }) : state.promises.setImmediate("tick", { signal: abort.signal });
    await expect(pending).rejects.toMatchObject(abortFailure("already"));
    expect(state.active.size).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });
}

for (const fixture of ["timer-promises", "timer-promises-pending-close"]) {
  test(`${fixture} guest source also runs against the real builtin factory`, async () => {
    const promises = nativeScheduling();
    const file = new URL(`../tests/fixtures/${fixture}/index.ts`, import.meta.url);
    const body = readFileSync(file, "utf8").replace(/^import .*;$/gm, "");
    const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__run = async () => {${body}}`);
    const lines: string[] = [];
    const run: () => Promise<void> = runInNewContext(source, {
      assert, AbortController, Error,
      delay: promises.setTimeout, immediate: promises.setImmediate, interval: promises.setInterval,
      setInterval: promises.setInterval, console: { log: (line: string) => lines.push(line) },
    });
    await run();
    const expected = readFileSync(new URL(`../tests/fixtures/${fixture}/expected.txt`, import.meta.url), "utf8").trimEnd();
    expect(lines.join("\n")).toBe(expected);
  });
}
