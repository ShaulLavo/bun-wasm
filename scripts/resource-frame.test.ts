import { expect, test } from "bun:test";
import { resourceFrames } from "./resource-frame-source";

// resource_frame.ts over the engine's async-context slot and bootstrap.js's runInContext. A
// waiter is driven the way net.js pumpIo drives it: step, and on a throw, fail at once.
interface Waiter { ref: boolean; step(): boolean | "progress"; fail(error: unknown): void; watch?: boolean }
interface Frame {
  run<This, Args extends readonly unknown[], R>(callback: (this: This, ...args: Args) => R, receiver: This, args: Args): R | undefined;
  bind<W extends Waiter>(waiter: W): W;
  release(): void;
}

function frames() {
  const slot = { current: undefined as unknown };
  function runInContext(context: unknown, fn: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]) {
    const previous = slot.current;
    slot.current = context;
    try {
      return fn.apply(receiver, args);
    } finally {
      slot.current = previous;
    }
  }
  const module = resourceFrames({ getAsyncContext: () => slot.current, runInContext }) as { capture(): Frame };
  function capture(context: unknown): Frame {
    slot.current = context;
    const frame = module.capture();
    slot.current = undefined;
    return frame;
  }
  return { slot, capture };
}

function pumpOne(waiter: Waiter): boolean | "progress" | "failed" {
  try {
    return waiter.step();
  } catch (error) {
    waiter.fail(error);
    return "failed";
  }
}

test("run enters the captured frame, returns the callback's value and restores the caller", () => {
  const { slot, capture } = frames();
  const frame = capture("resource");
  const receiver = {};
  const value = {};
  slot.current = "caller";
  const seen: unknown[] = [];
  const result = frame.run(function (this: object, a: number, b: string) {
    seen.push(slot.current, this, a, b);
    return value;
  }, receiver, [1, "two"]);
  expect(result).toBe(value);
  expect(seen).toEqual(["resource", receiver, 1, "two"]);
  expect(seen[1]).toBe(receiver);
  expect(slot.current).toBe("caller");

  const error = new Error("thrown");
  let caught: unknown;
  try { frame.run(() => { throw error; }, undefined, []); } catch (thrown) { caught = thrown; }
  expect(caught).toBe(error);
  expect(slot.current).toBe("caller");
});

test("an empty captured frame is live, and a released frame runs nothing", () => {
  const { slot, capture } = frames();
  const empty = capture(undefined);
  slot.current = "caller";
  expect(empty.run(() => slot.current, undefined, [])).toBeUndefined();
  let calls = 0;
  empty.run(() => { calls++; }, undefined, []);
  expect(calls).toBe(1);
  empty.release();
  empty.release();
  expect(empty.run(() => { calls++; return "ran"; }, undefined, [])).toBeUndefined();
  expect(calls).toBe(1);
  expect(slot.current).toBe("caller");
});

test("bind keeps the waiter object and its receiver, and reads nothing else from it", () => {
  const { slot, capture } = frames();
  const frame = capture("resource");
  const reads: string[] = [];
  const seen: unknown[] = [];
  const waiter = {
    get ref() { reads.push("ref"); return true; },
    set ref(_value: boolean) { reads.push("set ref"); },
    get watch() { reads.push("watch"); return true; },
    subscriptions() { reads.push("subscriptions"); return new Uint8Array(0); },
    step(this: unknown) { seen.push(["step", slot.current, this]); return "progress" as const; },
    fail(this: unknown, error: unknown) { seen.push(["fail", slot.current, this, error]); },
  };
  expect(frame.bind(waiter)).toBe(waiter);
  expect(reads).toEqual([]);
  slot.current = "pump";
  expect(waiter.step()).toBe("progress");
  const error = new Error("failed");
  waiter.fail(error);
  expect(seen).toEqual([["step", "resource", waiter], ["fail", "resource", waiter, error]]);
  expect((seen[1] as unknown[])[3]).toBe(error);
  expect(slot.current).toBe("pump");
  expect(reads).toEqual([]);
});

test("a released waiter's step reports done without running, and its fail dispatches nothing", () => {
  const { slot, capture } = frames();
  const frame = capture("resource");
  const seen: string[] = [];
  const waiter: Waiter = frame.bind({ ref: true, step: () => { seen.push("step"); return false; }, fail: () => { seen.push("fail"); } });
  frame.release();
  slot.current = "pump";
  expect(waiter.step()).toBe(true);
  waiter.fail(new Error("late"));
  expect(seen).toEqual([]);
  expect(slot.current).toBe("pump");
});

test("a step that releases its resource and then throws fails in that step's frame", () => {
  const { slot, capture } = frames();
  const frame = capture("resource");
  const error = new Error("listener");
  const seen: unknown[] = [];
  const waiter: Waiter = frame.bind({
    ref: true,
    step() { seen.push(["step", slot.current]); frame.release(); throw error; },
    fail(caught) { seen.push(["fail", slot.current, caught]); },
  });
  slot.current = "pump";
  expect(pumpOne(waiter)).toBe("failed");
  expect(seen).toEqual([["step", "resource"], ["fail", "resource", error]]);
  expect((seen[1] as unknown[])[2]).toBe(error);
  expect(slot.current).toBe("pump");
  // The failure frame was one-shot: nothing is left to dispatch.
  waiter.fail(new Error("again"));
  expect(waiter.step()).toBe(true);
  expect(seen.length).toBe(2);
});

test("a throwing fail still restores the caller and keeps no failure frame", () => {
  const { slot, capture } = frames();
  const frame = capture("resource");
  const first = new Error("step");
  const second = new Error("fail");
  const waiter: Waiter = frame.bind({ ref: true, step() { frame.release(); throw first; }, fail() { throw second; } });
  slot.current = "pump";
  let caught: unknown;
  try { pumpOne(waiter); } catch (error) { caught = error; }
  expect(caught).toBe(second);
  expect(slot.current).toBe("pump");
  let calls = 0;
  const probe: Waiter = frame.bind({ ref: true, step: () => true, fail() { calls++; } });
  probe.fail(new Error("retired"));
  waiter.fail(new Error("retired"));
  expect(calls).toBe(0);
});

test("a nested dispatch of the same waiter does not replace the outer failure frame", () => {
  const { slot, capture } = frames();
  const frame = capture("resource");
  const inner = new Error("inner");
  const outer = new Error("outer");
  const seen: unknown[] = [];
  let depth = 0;
  const waiter: Waiter = frame.bind({
    ref: true,
    step() {
      depth++;
      if (depth === 2) throw inner;
      // A listener pumps synchronously, re-entering this waiter, then closes and throws.
      slot.current = "nested caller";
      pumpOne(waiter);
      seen.push(["after nested", slot.current]);
      frame.release();
      throw outer;
    },
    fail(error) { seen.push(["fail", slot.current, error]); },
  });
  slot.current = "pump";
  expect(pumpOne(waiter)).toBe("failed");
  expect(seen).toEqual([["fail", "resource", inner], ["after nested", "nested caller"], ["fail", "resource", outer]]);
  expect(slot.current).toBe("pump");
});

test("a live fail without a throwing step uses the live frame", () => {
  const { slot, capture } = frames();
  const frame = capture("resource");
  const seen: unknown[] = [];
  const waiter: Waiter = frame.bind({ ref: true, step: () => false, fail(error) { seen.push([slot.current, error]); } });
  slot.current = "cancel";
  waiter.fail("reason");
  expect(seen).toEqual([["resource", "reason"]]);
  expect(slot.current).toBe("cancel");
});

async function collect() {
  for (let n = 0; n < 4; n++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    Bun.gc(true);
  }
}

// The frame object is held only by the resource; a retained owner and old waiter let it go
// once released, without another pump, while a successful or failed step keeps nothing.
test("a released frame is not retained by its retained owner or waiter", async () => {
  const { slot, capture } = frames();
  let marker: object | undefined = { frame: "resource" };
  const ref = new WeakRef(marker);
  const frame = capture(marker);
  marker = undefined;
  const owner = {
    frame,
    waiter: frame.bind({ ref: true, step(): boolean { throw new Error("step"); }, fail() {} }),
  };
  pumpOne(owner.waiter);
  slot.current = undefined;
  await collect();
  expect(ref.deref()).toBeDefined();
  owner.frame.release();
  await collect();
  expect(ref.deref()).toBeUndefined();
  expect(owner.waiter.step()).toBe(true);
});
