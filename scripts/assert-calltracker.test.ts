import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { runInNewContext } from "node:vm";
import nativeAssert from "node:assert";

type AssertModule = {
  CallTracker: BunWasm.AssertionCallTrackerConstructor;
  strict: { CallTracker: BunWasm.AssertionCallTrackerConstructor };
};

type Factory = (internal: unknown) => unknown;

const root = new URL("../", import.meta.url);
function evaluate(path: URL): Factory {
  const source = readFileSync(path, "utf8");
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);
  const context: { factory?: unknown } = {};
  Object.assign(context, { process });
  runInNewContext(emitted, context);
  if (typeof context.factory !== "function") throw new Error(`Missing factory in ${path}`);
  return context.factory as Factory;
}

function isAssertModule(value: unknown): value is AssertModule {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  if (!("CallTracker" in value) || !("strict" in value)) return false;
  const strict = value.strict;
  return (typeof strict === "object" || typeof strict === "function") && strict !== null && "CallTracker" in strict;
}

function loadCurrent(): AssertModule {
  const util = evaluate(new URL("crates/bunwasm-runtime/src/js/util.ts", root))({
    require(name: string) {
      if (name === "inspect") return { nodeInspect: inspect };
      throw new Error(`Unexpected util dependency: ${name}`);
    },
  });
  const candidate = evaluate(new URL("crates/bunwasm-runtime/src/js/assert.ts", root))({
    require(name: string) {
      if (name === "util") return util;
      if (name === "inspect") return { nodeInspect: inspect };
      if (name === "partial_assert") return { create: () => () => {} };
      throw new Error(`Unexpected assert dependency: ${name}`);
    },
  });
  if (!isAssertModule(candidate)) throw new Error("Current assert module lacks the generic CallTracker API");
  return candidate;
}

function capture(fn: () => unknown) {
  try {
    fn();
    return { kind: "returned", details: {} };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("message" in error)) return { kind: "threw", value: String(error), details: {} };
    const detail = error as Error & { code?: string };
    const details = Object.fromEntries(Object.keys(error)
      .filter(key => /^(message|actual|expected|operator|stack trace) \d+$/.test(key))
      .map(key => [key, (error as unknown as Record<string, unknown>)[key]]));
    return { kind: "threw", name: "name" in error ? String(error.name) : "Error", code: detail.code, message: String(error.message), details };
  }
}

function exercise(assert: AssertModule) {
  const previous = process.noDeprecation;
  process.noDeprecation = true;
  try {
    const tracker = new assert.CallTracker();
    function add(a: number, b: number) {
      return a + b;
    }
    const receiver = { marker: true };
    const tracked = tracker.calls(add, 2);
    const value = tracked.call(receiver, 1, 2);
    const record = tracker.getCalls(tracked)[0];
    if (!record) throw new Error("Missing tracked call record");
    const report = tracker.report().map(detail => ({
      message: detail.message,
      actual: detail.actual,
      expected: detail.expected,
      operator: detail.operator,
    }));
    const verification = capture(() => tracker.verify());
    const firstError = verification.kind === "threw" ? verification.details : {};
    tracked(3, 4);
    tracker.verify();
    tracker.reset(tracked);
    const noop = tracker.calls(1);
    noop();
    const invalid = [
      capture(() => tracker.getCalls(add)),
      capture(() => tracker.calls(add, 0)),
      capture(() => tracker.calls(add, 1.5)),
      capture(() => tracker.calls(add, "2" as never)),
    ];
    const nullCall = capture(() => tracker.calls(null as never));
    const second = tracker.calls(() => {}, 1);
    const third = tracker.calls(() => {}, 1);
    const multiple = capture(() => tracker.verify());
    const multipleKeys = multiple.kind === "threw" ? Object.keys(multiple.details).filter(key => key.startsWith("message ")).length : 0;
    second();
    third();
    const exiting = process._exiting;
    process._exiting = true;
    const duringExit = capture(() => tracker.calls(() => {}, 1));
    process._exiting = exiting;
    return {
      value,
      thisArg: record.thisArg === receiver,
      arguments: Array.from(record.arguments),
      frozen: Object.isFrozen(record) && Object.isFrozen(record.arguments) && Object.isFrozen(tracker.getCalls(tracked)),
      report,
      verification,
      firstError,
      verifiedAfterSecond: tracker.report().length === 0,
      reset: tracker.getCalls(tracked).length,
      noop: tracker.getCalls(noop).length,
      invalid,
      multiple,
      multipleKeys,
      duringExit,
      nullCall: { kind: nullCall.kind, name: "name" in nullCall ? nullCall.name : undefined, code: "code" in nullCall ? nullCall.code : undefined },
    };
  } finally {
    process.noDeprecation = previous;
  }
}

test("current assert and strict expose the generic CallTracker API", () => {
  const current = loadCurrent();
  expect(typeof current.CallTracker).toBe("function");
  expect(typeof current.strict.CallTracker).toBe("function");
  const descriptor = Object.getOwnPropertyDescriptor(current, "CallTracker");
  expect(typeof descriptor?.get).toBe("function");
  expect(descriptor?.configurable).toBe(true);
  expect(descriptor?.enumerable).toBe(true);
});

test("current CallTracker matches the native Bun behavior contract", () => {
  if (!isAssertModule(nativeAssert)) throw new Error("Native Bun CallTracker oracle unavailable");
  expect(exercise(loadCurrent())).toEqual(exercise(nativeAssert));
});

test("CallTracker shares one lazy constructor per factory and isolates setters", () => {
  if (!isAssertModule(nativeAssert)) throw new Error("Native Bun CallTracker oracle unavailable");
  expect(nativeAssert.CallTracker).toBe(nativeAssert.strict.CallTracker);
  const current = loadCurrent();
  const first = current.CallTracker;
  expect(first).toBe(current.strict.CallTracker);
  const other = loadCurrent();
  expect(other.CallTracker).not.toBe(first);
  expect(other.CallTracker).toBe(other.strict.CallTracker);
  const firstTracker = new first();
  const secondTracker = new current.strict.CallTracker();
  const tracked = firstTracker.calls(() => {}, 1);
  tracked();
  expect(firstTracker.report()).toEqual([]);
  expect(secondTracker.report()).toEqual([]);
  class Replacement extends first {}
  Object.defineProperty(current, "CallTracker", { value: Replacement, writable: true, enumerable: true, configurable: true });
  expect(current.CallTracker).toBe(Replacement);
  expect(current.strict.CallTracker).not.toBe(Replacement);
});
