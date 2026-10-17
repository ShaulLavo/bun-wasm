import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { promiseHooks } from "node:v8";

type Result = { ok: true } | { error: unknown };
type Observer = {
  track<T>(value: T): T;
  unhandled(error: unknown, promise: unknown): boolean;
  complete(result: { ok: true }, finish: (result: Result) => void): Promise<void>;
};
const root = process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url));
const settled = new WeakSet<object>();
const stop = promiseHooks.onSettled(promise => settled.add(promise));
const factory = (0, eval)(stripTypeScriptTypes(readFileSync(`${root}/crates/bunwasm-runtime/src/js/test_matchers.ts`, "utf8")));
const support: { pending(): Observer } = factory({
  isPromise: types.isPromise,
  promiseState: (promise: Promise<unknown>) => settled.has(promise) ? "settled" : "pending",
});
let current: Observer | undefined;
function start() { return current = support.pending(); }
function onRejection(error: unknown, promise: unknown) {
  if (!current?.unhandled(error, promise)) throw error;
}
process.on("unhandledRejection", onRejection);

try {
  let reads = 0;
  const value = { get then() {
    if (++reads === 1) return undefined;
    throw new Error("second-assimilation");
  } };
  const original = Promise.resolve(value);
  const observer = start();
  const adapter = { method() { return observer.track(original); } };
  assert.equal(adapter.method(), original);
  assert.equal(await adapter.method(), value);
  assert.equal(reads, 1);
  await observer.complete({ ok: true }, result => assert.deepEqual(result, { ok: true }));

  for (const reason of [undefined, null, false, 0, ""]) {
    const caught = start();
    let handled = false;
    try { await caught.track(Promise.reject(reason)); } catch (error) {
      handled = true;
      assert.equal(error, reason);
    }
    assert.equal(handled, true);
    await caught.complete({ ok: true }, result => assert.deepEqual(result, { ok: true }));
    const stray = start();
    stray.track(Promise.reject(reason));
    await stray.complete({ ok: true }, result => {
      assert.equal("error" in result, true);
      if ("error" in result) assert.equal(result.error, reason);
    });
  }

  const inspected = start();
  const reason = new Error("constructor inspection is not handling");
  const promise = inspected.track(Promise.reject(reason));
  void promise.constructor;
  Promise.resolve(promise);
  await inspected.complete({ ok: true }, result => {
    assert.equal("error" in result, true);
    if ("error" in result) assert.equal(result.error, reason);
  });
  const delayed = start();
  const later = delayed.track(new Promise((_, reject) => setTimeout(() => reject(reason), 1)));
  const handled = later.catch(error => assert.equal(error, reason));
  await delayed.complete({ ok: true }, result => assert.deepEqual(result, { ok: true }));
  await handled;
  console.log("fulfilled identity: PASS; getter reads: 1; falsy controls: 10 PASS; inspection and delayed catch: PASS");
} finally {
  process.removeListener("unhandledRejection", onRejection);
  stop();
}
