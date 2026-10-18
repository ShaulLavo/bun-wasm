import { controlLoad, controlStore, controlAdd } from "waffle/proc/control";
import { expect, test } from "bun:test";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { engineInterruptionTransport } from "./engine-interruption-transport";

// Select real generic views, not a replacement of the removed Bun transport.
test("generic engine probe uses authoritative offset signals and the actual runtime_proc.poll readiness word", () => {
  const runtimeProcess = createWorkerProcessTransport();
  const state = workerProcessState(runtimeProcess);
  const selected = engineInterruptionTransport({ runtimeProcess, engine: "quickjs" });
  expect(selected.route).toBe("runtimeProcess");
  expect(selected.requestedSignal.buffer).toBe(runtimeProcess.directory);
  expect(selected.requestedSignal.byteOffset).toBe(state.signals.requestedSignal.byteOffset);
  expect(selected.signalState.byteOffset).toBe(state.signals.signalState.byteOffset);
  expect(selected.signalState.length).toBe(65);
  expect(selected.waitWord.buffer).toBe(state.wake.buffer);
  expect(selected.waitWord.byteOffset).toBe(state.wake.byteOffset);
  expect(selected.waitWord.byteOffset).toBe(4);
  expect(selected.waitWord.length).toBe(1);
  controlStore(selected.requestedSignal, 0, 15);
  controlStore(selected.signalState, 2, 6);
  expect(controlLoad(state.signals.requestedSignal, 0)).toBe(15);
  expect(controlLoad(state.signals.signalState, 2)).toBe(6);
  expect(controlLoad(new Int32Array(runtimeProcess.directory), 0)).not.toBe(15);
});

test("probe rejects a request without its actual production transport", () => {
  expect(() => engineInterruptionTransport({})).toThrow("production signal and wait transport");
});

for (const root of [false, true]) test(`Preview1 ${root ? "Bun composition root" : "sibling worker"} selects the exact WASI interrupt wait cell, not process readiness`, () => {
  const runtimeProcess = createWorkerProcessTransport();
  const state = workerProcessState(runtimeProcess);
  const selected = engineInterruptionTransport(root ? { runtimeProcess, engine: "browser", adapter: "preview1" } : { runtimeProcess });
  expect(selected.route).toBe("runtimeProcess");
  expect(selected.waitWord.buffer).toBe(state.signals.interrupt.buffer);
  expect(selected.waitWord.byteOffset).toBe(state.signals.interrupt.byteOffset);
  expect(selected.waitWord.length).toBe(1);
  expect(selected.waitWord.byteOffset).not.toBe(state.wake.byteOffset);
  controlStore(selected.waitWord, 0, 2);
  expect(controlLoad(state.signals.interrupt, 0)).toBe(2);
  expect(controlLoad(state.wake, 0)).toBe(0);
});

test("both Bun engines observe the same service-owned readiness sequence", () => {
  const runtimeProcess = createWorkerProcessTransport();
  const quickjs = engineInterruptionTransport({ runtimeProcess, engine: "quickjs" });
  const jsc = engineInterruptionTransport({ runtimeProcess, engine: "jsc" });
  controlAdd(quickjs.waitWord, 0, 1);
  expect(controlLoad(jsc.waitWord, 0)).toBe(1);
});
