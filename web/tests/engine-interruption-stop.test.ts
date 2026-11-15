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
  const stop = new CooperativeWorkerStop(() => { nativeStops++; returned(); });
  return { stop, observer, nativeStops: () => nativeStops };
}

for (const first of ["exit", "return"] as const) {
  test(`native return stays pending until both proof events, ${first} first`, async () => {
    const { stop, observer, nativeStops } = fixture();
    let acknowledged = false;
    const pending = stop.request();
    void pending.then(() => { acknowledged = true; });
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
      await pending;
      expect(acknowledged).toBe(true);
      expect(nativeStops()).toBe(1);
      expect(observer.read()).toEqual({ kind: "terminated" });
      stop.observeExit(); stop.observeReturn(); stop.force();
      expect(nativeStops()).toBe(1);
    } finally { stop.force(); }
  });
}

test("a completed proof may receive a later stop request", async () => {
  const { stop, observer, nativeStops } = fixture();
  try {
    stop.observeExit(); stop.observeReturn();
    expect(nativeStops()).toBe(0);
    expect(observer.read().kind).toBe("selected");
    await stop.request();
    expect(nativeStops()).toBe(1);
    expect(observer.read().kind).toBe("terminated");
  } finally { stop.force(); }
});

test("failed-proof cleanup releases a held stop even with no completion events", async () => {
  const { stop, observer, nativeStops } = fixture();
  try {
    const pending = stop.request();
    stop.force();
    await pending;
    await stop.request();
    expect(nativeStops()).toBe(1);
    expect(observer.read().kind).toBe("terminated");
  } finally { stop.force(); }
});
