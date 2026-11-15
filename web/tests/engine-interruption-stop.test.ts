import { expect, test } from "bun:test";
import { captureNativeReturn, captureProcessObserver } from "waffle/proc/observation";
import { claimOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { CooperativeWorkerStop } from "./engine-interruption-stop";

function fixture() {
  const transport = createWorkerProcessTransport({ capacity: 1 });
  const state = workerProcessState(transport);
  const observer = captureProcessObserver(transport);
  const returned = captureNativeReturn(transport);
  claimOutcome(state.signals.outcome, { kind: "signaled", code: 10 });
  let nativeStops = 0;
  const stop = new CooperativeWorkerStop(() => { nativeStops++; });
  return { stop, observer, returned, nativeStops: () => nativeStops };
}

for (const first of ["exit", "return"] as const) {
  test(`execution acknowledgement stays pending until both proof events, ${first} first`, async () => {
    const { stop, observer, returned, nativeStops } = fixture();
    let acknowledged = false;
    const pending = stop.request();
    const nativeReturn = pending.then(() => { returned(); acknowledged = true; });
    const selected: ReturnType<typeof observer.read> = { kind: "selected", result: { kind: "signaled", code: 10, status: 138 } };
    try {
      expect(stop.request()).toBe(pending);
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      expect(observer.read()).toEqual(selected);
      if (first === "exit") stop.observeExit(); else stop.observeReturn();
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      expect(nativeStops()).toBe(0);
      expect(observer.read()).toEqual(selected);
      if (first === "exit") stop.observeReturn(); else stop.observeExit();
      await nativeReturn;
      expect(acknowledged).toBe(true);
      expect(nativeStops()).toBe(0);
      expect(observer.read()).toEqual({ kind: "terminated" });
      stop.observeExit(); stop.observeReturn();
      expect(nativeStops()).toBe(0);
      stop.force();
      expect(nativeStops()).toBe(1);
    } finally { stop.force(); }
  });
}

test("a completed proof may receive a later stop request", async () => {
  const { stop, observer, returned, nativeStops } = fixture();
  try {
    stop.observeExit(); stop.observeReturn();
    expect(nativeStops()).toBe(0);
    expect(observer.read().kind).toBe("selected");
    await stop.request();
    returned();
    expect(nativeStops()).toBe(0);
    expect(observer.read().kind).toBe("terminated");
  } finally { stop.force(); }
});

test("failed-proof cleanup acknowledges actual forced stop without claiming proof events", async () => {
  const { stop, observer, returned, nativeStops } = fixture();
  try {
    const pending = stop.request();
    stop.force();
    await pending;
    returned();
    await stop.request();
    expect(nativeStops()).toBe(1);
    expect(observer.read().kind).toBe("terminated");
  } finally { stop.force(); }
});


test("a failed native stop cannot acknowledge failed-proof cleanup", async () => {
  const failure = new Error("native stop failed");
  let fail = true;
  let physicallyStopped = false;
  let acknowledged = false;
  const stop = new CooperativeWorkerStop(() => {
    if (fail) throw failure;
    physicallyStopped = true;
  });
  const pending = stop.request();
  void pending.then(() => { acknowledged = true; });
  try {
    expect(() => stop.force()).toThrow(failure);
    await Promise.resolve();
    expect(physicallyStopped).toBe(false);
    expect(acknowledged).toBe(false);
    fail = false;
    stop.force();
    await pending;
    expect(physicallyStopped).toBe(true);
    expect(acknowledged).toBe(true);
  } finally { fail = false; stop.force(); }
});
