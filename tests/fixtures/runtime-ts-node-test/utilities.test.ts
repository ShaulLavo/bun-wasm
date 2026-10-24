import assert from "node:assert/strict";
import test, { it, suite, describe, before, after, beforeEach, afterEach } from "node:test";

assert.equal(test.test, test);
assert.equal(it, test);
assert.equal(suite, describe);
assert.equal(test.before, before);
assert.equal(test.after, after);
assert.equal(test.beforeEach, beforeEach);
assert.equal(test.afterEach, afterEach);
const seen: string[] = [];
before(() => { seen.push("before"); });
beforeEach(() => { seen.push("beforeEach"); });
afterEach(() => { seen.push("afterEach"); });
after(() => {
  assert.deepEqual(seen, ["before", "beforeEach", "first", "afterEach", "beforeEach", "second", "afterEach", "beforeEach", "unnamed", "afterEach", "beforeEach", "anonymous", "afterEach"]);
  console.log("node:test aliases, options, async callbacks and hooks");
});
test("callback overload", () => { seen.push("first"); });
test("options overload", { timeout: 1000 }, async () => { await Promise.resolve(); seen.push("second"); });
test(function unnamed() { seen.push("unnamed"); });
test({ timeout: 100 }, () => { seen.push("anonymous"); });
test("skip option", { skip: true }, () => { throw new Error("must skip"); });
test("todo option", { todo: true }, () => { throw new Error("must defer"); });
test.skip("skip method", () => { throw new Error("must skip"); });
test.todo("todo method");
test.skip(function skippedUnnamed() { throw new Error("must skip"); });
test.todo({ timeout: 100 }, function deferredUnnamed() {});
