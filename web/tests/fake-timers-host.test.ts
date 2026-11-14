import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../src/buffer-transfer.ts";
import { SLOT_NAMES } from "../src/net/trampoline.ts";
import { createScriptEvaluation } from "../src/script-evaluation.ts";

const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");

test.each([
  { advanceMs: 100, replacesWake: true },
  { advanceMs: 1001, replacesWake: false },
])("restoring guest Date preserves the captured clock after $advanceMs ms", ({ advanceMs, replacesWake }) => {
  let nativeNow = 10_000;
  const scheduled: { callback: () => void; delay: number }[] = [];
  const cancelled: number[] = [];
  const context = createContext({ TextEncoder, TextDecoder, URL, Blob,
    Date: class extends Date { static override now() { return nativeNow; } },
    setTimeout(callback: () => void, delay: number) { return scheduled.push({ callback, delay }); },
    clearTimeout(handle: number) { cancelled.push(handle); },
    queueMicrotask, isWasmMemoryBuffer, transferArrayBuffers, createScriptEvaluation, SLOT_NAMES });
  const EngineHost = runInContext(source + "\nEngineHost;", context);
  const host = Object.assign(Object.create(EngineHost.prototype), {
    o: {},
    exited: false, timer: null, timerAt: Infinity,
  });
  const realDate = runInContext("Date", context);
  let pumps = 0;
  host.pump = () => { pumps++; };
  try {
    runInContext("globalThis.savedDate = Date; globalThis.Date = { now: () => 0 };", context);
    host.schedule(1000);
    const armed = host.timer;
    expect(armed).toBe(1);
    expect(scheduled.map(timer => timer.delay)).toEqual([1000]);
    expect(cancelled).toEqual([]);
    expect(pumps).toBe(0);
    nativeNow += advanceMs;
    runInContext("globalThis.Date = savedDate;", context);
    expect(runInContext("Date", context)).toBe(realDate);
    host.schedule(1);
    expect(host.timer).toBe(replacesWake ? 2 : armed);
    expect(cancelled).toEqual(replacesWake ? [armed] : []);
    expect(scheduled.map(timer => timer.delay)).toEqual(replacesWake ? [1000, 1] : [1000]);
    expect(pumps).toBe(0);
    scheduled[replacesWake ? 1 : 0]!.callback();
    expect(pumps).toBe(1);
    expect(host.timer).toBeNull();
    expect(host.timerAt).toBe(Infinity);
  } finally {
    context.Date = realDate;
    if (host.timer !== null) context.clearTimeout(host.timer);
  }
});

test("the browser fake checkpoint drains runtime nextTicks synchronously", () => {
  const context = createContext({ TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask, isWasmMemoryBuffer, transferArrayBuffers, createScriptEvaluation, SLOT_NAMES });
  const EngineHost = runInContext(source + "\nEngineHost;", context);
  let drained = false;
  const host = Object.assign(Object.create(EngineHost.prototype), {
    o: {},
    tickQueued: true,
    internal: { runTicks() { drained = true; } },
    guard<T>(callback: () => T) { return callback(); },
  });
  host.valueNatives().runMicrotasks();
  expect(drained).toBe(true);
  expect(host.tickQueued).toBe(false);
});
