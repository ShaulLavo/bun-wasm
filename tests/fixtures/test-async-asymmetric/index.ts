import { expect, mock } from "bun:test";

function asymmetric(name: string, ...args: unknown[]): unknown {
  const matcher: unknown = Reflect.get(expect, name);
  if (typeof matcher !== "function") throw new Error(`missing ${name}`);
  return Reflect.apply(matcher, expect, args);
}

function inverted(name: string, ...args: unknown[]): unknown {
  const matcher: unknown = Reflect.get(expect.not, name);
  if (typeof matcher !== "function") throw new Error(`missing inverted ${name}`);
  return Reflect.apply(matcher, expect.not, args);
}

const events: string[] = [];
const original = new Error("asymmetric rejection");
const rejectedReason = "asymmetric rejection";
expect.extend({
  asyncValue(value, expected) {
    events.push(`start ${String(value)}`);
    return Promise.resolve().then(() => {
      events.push(`end ${String(value)}`);
      return { pass: Object.is(value, expected) };
    });
  },
  syncValue(value, expected) { return { pass: Object.is(value, expected) }; },
  rejectedValue() { return Promise.reject(rejectedReason); },
  thrownValue() { throw original; },
  timerValue() {
    events.push("matcher");
    return new Promise(resolve => setTimeout(() => { events.push("timer"); resolve({ pass: true }); }, 0));
  },
  thenableValue() {
    return { pass: true, get then() { throw new Error("plain thenable adopted"); } };
  },
});

const cases: [string, () => unknown][] = [
  ["synchronous returns", () => {
    expect(expect(1).toEqual(asymmetric("syncValue", 1))).toBeUndefined();
    expect(expect({ value: 1 }).toEqual({ value: asymmetric("syncValue", 1) })).toBeUndefined();
    expect(Bun.deepEquals({ value: 1 }, { value: 1 })).toBe(true);
    expect(Bun.deepEquals(1, asymmetric("asyncValue", 1))).toBe(false);
  }],
  ["direct and negated settlement", async () => {
    await expect(1).toEqual(asymmetric("asyncValue", 1));
    await expect(0).not.toEqual(asymmetric("asyncValue", 1));
    await expect(0).toEqual(inverted("asyncValue", 1));
    await expect(1).not.toEqual(inverted("asyncValue", 1));
  }],
  ["bounded async after-call order", async () => {
    events.length = 0;
    events.push("before");
    const result = expect(1).toEqual(asymmetric("asyncValue", 1));
    events.push("after");
    // Bounded contract: native Bun drains before returning undefined. We return a final Promise.
    expect(result instanceof Promise).toBe(true);
    expect(events).toEqual(["before", "start 1", "after"]);
    await result;
    expect(events).toEqual(["before", "start 1", "after", "end 1"]);
  }],
  ["bounded timer after-call order", async () => {
    events.length = 0;
    events.push("before");
    const result = expect(1).toEqual(asymmetric("timerValue"));
    events.push("after");
    expect(result instanceof Promise).toBe(true);
    expect(events).toEqual(["before", "matcher", "after"]);
    await result;
    expect(events).toEqual(["before", "matcher", "after", "timer"]);
  }],
  ["nested order and single getter reads", async () => {
    events.length = 0;
    await expect({
      get a() { events.push("get a"); return 1; },
      get b() { events.push("get b"); return 2; },
    }).toEqual({ a: asymmetric("asyncValue", 1), b: asymmetric("asyncValue", 2) });
    expect(events).toEqual(["get a", "start 1", "end 1", "get b", "start 2", "end 2"]);
  }],
  ["short circuit", async () => {
    events.length = 0;
    await expect({
      get a() { events.push("get a"); return 0; },
      get b() { throw new Error("short circuit read"); },
    }).not.toEqual({ a: asymmetric("asyncValue", 1), b: asymmetric("asyncValue", 2) });
    expect(events).toEqual(["get a", "start 0", "end 0"]);
  }],
  ["missing keys and sparse arrays", async () => {
    events.length = 0;
    await expect({}).not.toEqual({ missing: asymmetric("asyncValue", undefined) });
    expect(events).toEqual([]);
    await expect(Array(1)).toEqual([asymmetric("asyncValue", undefined)]);
    events.length = 0;
    await expect(Array(1)).not.toStrictEqual([asymmetric("asyncValue", undefined)]);
    expect(events).toEqual([]);
  }],
  ["maps sets and cycles", async () => {
    await expect(new Map([["value", 1]])).toEqual(new Map([["value", asymmetric("asyncValue", 1)]]));
    await expect(new Set([1, 2])).toEqual(new Set([asymmetric("asyncValue", 2), asymmetric("asyncValue", 1)]));
    const received: { value: number; self?: unknown } = { value: 1 }; received.self = received;
    const expected: { value: unknown; self?: unknown } = { value: asymmetric("asyncValue", 1) }; expected.self = expected;
    await expect(received).toEqual(expected);
  }],
  ["containing and property callers", async () => {
    await expect({ value: 1, extra: true }).toEqual(expect.objectContaining({ value: asymmetric("asyncValue", 1) }));
    await expect([0, 1]).toEqual(expect.arrayContaining([asymmetric("asyncValue", 1)]));
    await expect({ value: 1, extra: true }).toMatchObject({ value: asymmetric("asyncValue", 1) });
    await expect([{ value: 1 }]).toContainEqual({ value: asymmetric("asyncValue", 1) });
    await expect({ value: 1 }).toHaveProperty("value", asymmetric("asyncValue", 1));
    await expect(Promise.resolve({ value: 1 })).resolves.toEqual({ value: asymmetric("asyncValue", 1) });
  }],
  ["rejection wrapping and cleanup", async () => {
    let caught: unknown;
    try { await expect({ value: 1 }).toEqual({ value: asymmetric("rejectedValue") }); } catch (error) { caught = error; }
    if (!(caught instanceof Error)) throw new Error("missing matcher rejection wrapper");
    expect(caught).not.toBe(rejectedReason);
    expect(caught.message).toBe("Matcher `rejectedValue` returned a promise that rejected");
    expect("cause" in caught).toBe(false);
    try { expect(1).toEqual(asymmetric("thrownValue")); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    await expect({ value: 1 }).toEqual({ value: asymmetric("asyncValue", 1) });
  }],
  ["plain thenables and intrinsic reactions", async () => {
    expect(expect(1).toEqual(asymmetric("thenableValue"))).toBeUndefined();
    const promise = Promise.resolve({ pass: true });
    Object.defineProperty(promise, "then", { get() { throw new Error("promise then read"); } });
    expect.extend({ intrinsicValue: () => promise });
    await expect(1).toEqual(asymmetric("intrinsicValue"));
    await expect(1).toEqual(asymmetric("intrinsicValue"));
  }],
  ["reentrant comparisons", async () => {
    expect.extend({ reentrantValue(value) {
      return Promise.resolve().then(async () => {
        await expect({ inner: value }).toEqual({ inner: asymmetric("asyncValue", value) });
        return { pass: true };
      });
    } });
    await expect({ value: 1 }).toEqual({ value: asymmetric("reentrantValue") });
  }],
  ["expected-first precedence and silent mismatch messages", async () => {
    const order: string[] = [];
    expect.extend({
      first() { order.push("expected"); return Promise.resolve({ pass: true }); },
      second() { throw new Error("received matcher must not run"); },
      silent() { return Promise.resolve({ pass: false, message() { throw new Error("message must not run"); } }); },
    });
    await expect(asymmetric("second")).toEqual(asymmetric("first"));
    const identical = asymmetric("first");
    await expect(identical).toEqual(identical);
    await expect(1).not.toEqual(asymmetric("silent"));
    expect(order).toEqual(["expected", "expected"]);
    await expect(asymmetric("asyncValue", 1)).toEqual(1);
  }],
  ["Map first matching key and Set candidate reuse", async () => {
    const order: string[] = [];
    expect.extend({
      anyKey() { order.push("any"); return Promise.resolve({ pass: true }); },
      oneKey(value) { order.push("one"); return Promise.resolve({ pass: value === 1 }); },
    });
    const expected = new Map([[asymmetric("anyKey"), "good"], [asymmetric("oneKey"), "bad"]]);
    await expect(new Map([[1, "bad"], [2, "good"]])).not.toEqual(expected);
    expect(order).toEqual(["any"]);
    await expect(new Set([1, 2])).toEqual(new Set([asymmetric("asyncValue", 1), asymmetric("anyKey")]));
    order.length = 0;
    await expect(new Set([1, 2])).toEqual(new Set([asymmetric("anyKey"), asymmetric("oneKey")]));
    expect(order).toEqual(["any", "any"]);
  }],
  ["context equals requires await for nested async comparisons", async () => {
    expect.extend({ nested: async function(value, expected) {
      // Native returns boolean here. The bounded contract requires await or a returned chain.
      const comparison: unknown = this.equals(value, expected);
      if (!(comparison instanceof Promise)) throw new Error("nested equality must expose its Promise");
      return { pass: await comparison };
    } });
    await expect({ value: 1 }).toEqual(asymmetric("nested", { value: asymmetric("asyncValue", 1) }));
    await expect({ value: 0 }).not.toEqual(asymmetric("nested", { value: asymmetric("asyncValue", 1) }));
  }],
  ["all mock comparison callers and throw callers settle", async () => {
    const fn = mock((value: number) => ({ value }));
    fn(0); fn(1);
    await expect(fn).toHaveBeenCalledWith(asymmetric("asyncValue", 1));
    await expect(fn).toHaveBeenLastCalledWith(asymmetric("asyncValue", 1));
    await expect(fn).toHaveBeenNthCalledWith(2, asymmetric("asyncValue", 1));
    await expect(fn).not.toHaveBeenNthCalledWith(1, asymmetric("asyncValue", 1));
    await expect(fn).toHaveReturnedWith({ value: asymmetric("asyncValue", 1) });
    await expect(fn).toHaveLastReturnedWith({ value: asymmetric("asyncValue", 1) });
    await expect(fn).toHaveNthReturnedWith(2, { value: asymmetric("asyncValue", 1) });
    await expect(fn).not.toHaveNthReturnedWith(1, { value: asymmetric("asyncValue", 1) });
    await expect(() => { throw 1; }).toThrow(asymmetric("asyncValue", 1));
    await expect(() => { throw 0; }).not.toThrow(asymmetric("asyncValue", 1));
    await expect(1).toBeOneOf([asymmetric("asyncValue", 0), asymmetric("asyncValue", 1)]);
    await expect(Promise.reject(1)).rejects.toEqual(asymmetric("asyncValue", 1));
  }],
  ["later getter and settled validation errors preserve identity", async () => {
    const later = new Error("later getter");
    let caught: unknown;
    try {
      await expect({ a: 1, get b() { throw later; } }).toEqual({ a: asymmetric("asyncValue", 1), b: 2 });
    } catch (error) { caught = error; }
    expect(caught).toBe(later);
    expect.extend({ invalidSettled: () => Promise.resolve({ get pass() { throw later; } }) });
    try { await expect(1).toEqual(asymmetric("invalidSettled")); } catch (error) { caught = error; }
    expect(caught).toBe(later);
    let reads = 0;
    const received = { get value() { reads++; return 1; } };
    await expect(received).toEqual({ value: asymmetric("asyncValue", 1) });
    expect(reads).toBe(1);
  }],
  ["error cause getters and async causes are visited once", async () => {
    let reads = 0, calls = 0;
    expect.extend({ cause(value) { calls++; return Promise.resolve({ pass: value === 1 }); } });
    const actual = new Error("same");
    Object.defineProperty(actual, "cause", { enumerable: true, get() { reads++; return 1; } });
    const expected = new Error("same", { cause: asymmetric("cause") });
    Object.defineProperty(expected, "cause", { enumerable: true });
    await expect(actual).toEqual(expected);
    expect(reads).toBe(1);
    expect(calls).toBe(1);
  }],
  ["completed siblings and failed candidates release memo frames", async () => {
    let calls = 0;
    expect.extend({ counted(value) { calls++; return Promise.resolve({ pass: value === 1 }); } });
    const shared = { value: 1 };
    const expected = { value: asymmetric("counted") };
    await expect([shared, shared]).toEqual([expected, expected]);
    expect(calls).toBe(2);
    await expect(new Set([{ value: 0 }, shared])).not.toEqual(new Set([expected, { value: 2 }]));
    await expect(shared).toEqual(expected);
  }],
];

let failures = 0;
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${String(error)}`); }
}
if (failures) throw new Error(`${failures} async asymmetric regressions`);
