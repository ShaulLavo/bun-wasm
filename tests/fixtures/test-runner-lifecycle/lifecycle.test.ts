import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, describe, jest, onTestFinished, test } from "bun:test";

assert.throws(() => test.failing("missing"), /test.failing expects a function as the second argument/);
assert.throws(() => onTestFinished(() => {}), /Cannot call onTestFinished\(\) outside of a test/);
assert.throws(() => Reflect.apply(onTestFinished, undefined, [1]), {
  name: "Error", message: "onTestFinished() expects a function as the first argument",
});
assert.throws(() => test("both", () => {}, { retry: 1, repeats: 1 }), /Cannot set both retry and repeats/);
for (const repeats of [null, "bad", false]) {
  assert.throws(() => Reflect.apply(test, undefined, ["invalid repeats", () => {}, { retry: 1, repeats }]), /expects repeats to be a number/);
}
assert.equal(jest.setTimeout(5000), undefined);

describe("retry lifecycle", () => {
  const log: string[] = [];
  let attempts = 0;
  async function retry() {
    attempts++;
    onTestFinished(async () => { await Promise.resolve(); log.push("finished first"); });
    onTestFinished(() => { log.push("finished second"); });
    afterAll(() => { log.push("inner first"); });
    afterAll(() => { log.push("inner second"); });
    log.push("test");
    if (attempts < 3) throw new Error("intentional retry");
  }
  describe("attempts", () => {
    beforeEach(() => { log.push("before"); });
    afterEach(() => { log.push("after"); });
    test("retry", retry, { retry: 3 });
  });
  test("verify retry", () => {
    assert.equal(attempts, 3);
    assert.deepEqual(log, Array.from({ length: 3 }, () => ["before", "test", "inner second", "inner first", "after", "finished first", "finished second"]).flat());
    console.log("retry lifecycle verified");
  });
});

describe("repeat lifecycle", () => {
  const log: string[] = [];
  function repeat() {
    log.push("test");
    onTestFinished(() => { log.push("finished"); });
  }
  describe("attempts", () => {
    beforeEach(() => { log.push("before"); });
    afterEach(() => { log.push("after"); });
    test("repeat", repeat, { repeats: 2 });
  });
  test("verify repeats", () => {
    assert.deepEqual(log, Array.from({ length: 3 }, () => ["before", "test", "after", "finished"]).flat());
    console.log("repeat lifecycle verified");
  });
});
test("validation completed", () => {
  assert.throws(() => test.failing("missing"), /test.failing expects a function as the second argument/);
  console.log("validation verified");
});

describe("live cleanup", () => {
  const log: string[] = [];
  function local() {
    log.push("local");
    afterAll(() => { log.push("local reentry"); });
    onTestFinished(() => { log.push("local finished"); });
  }
  function finished() {
    log.push("finished");
    onTestFinished(() => { log.push("finished reentry"); });
  }
  describe("one attempt", () => {
    afterEach(() => { log.push("after"); onTestFinished(() => { log.push("after finished"); }); });
    test("live queues", () => { afterAll(local); onTestFinished(finished); });
  });
  test("verify live queues", () => {
    assert.deepEqual(log, ["local", "local reentry", "after", "finished", "local finished", "after finished", "finished reentry"]);
    console.log("live cleanup verified");
  });
});
