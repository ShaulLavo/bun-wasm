import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { types } from "node:util";

type Completion = { ok: true } | { error: unknown };
type Observer = { track<T>(value: T): T; complete(result: { ok: true }, finish: (result: Completion) => void): Promise<void> };
const factory = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false }).transformSync(readFileSync(new URL("../../crates/bunwasm-runtime/src/js/test_matchers.ts", import.meta.url), "utf8"));
// oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
const support: { pending(): Observer } = (0, eval)(factory)({ isPromise: types.isPromise, promiseState: Bun.peek.status });

test("pending assertion observers retain fulfilled accessor identity", async () => {
  let reads = 0;
  const value = { get then() {
    if (++reads === 1) return undefined;
    throw new Error("second-assimilation");
  } };
  const original = Promise.resolve(value);
  const observer = support.pending();
  const adapter = { method() { return observer.track(original); } };
  expect(await adapter.method()).toBe(value);
  expect(reads).toBe(1);
  await observer.complete({ ok: true }, result => expect(result).toEqual({ ok: true }));
});

test("pending assertion observers preserve caught falsy rejection identities", async () => {
  for (const reason of [undefined, null, false, 0, ""]) {
    const observer = support.pending();
    let caught = false;
    try { await observer.track(Promise.reject(reason)); } catch (error) {
      caught = true;
      expect(error).toBe(reason);
    }
    expect(caught).toBe(true);
    await observer.complete({ ok: true }, result => expect(result).toEqual({ ok: true }));
  }
});

test("native rejection tracking retains unawaited falsy reasons and ignores inspection", () => {
  const result = Bun.spawnSync(["node", new URL("../../scripts/check-await-observer.ts", import.meta.url).pathname]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("falsy controls: 10 PASS; inspection and delayed catch: PASS");
});

test("pending assertion cleanup preserves a caller's constructor replacement", async () => {
  const observer = support.pending();
  const promise = Promise.resolve(1);
  expect(observer.track(promise)).toBe(promise);
  expect(await promise).toBe(1);
  class Replacement extends Promise<unknown> {}
  Object.defineProperty(promise, "constructor", { value: Replacement, configurable: true });
  await observer.complete({ ok: true }, result => expect(result).toEqual({ ok: true }));
  expect(promise.constructor).toBe(Replacement);
});
