const assert = require("assert");
assert(true);
assert.ok(1);
assert.equal(1, "1");
assert.strictEqual(1, 1);
assert.deepEqual({ a: [1, 2] }, { a: [1, 2] });
assert.deepStrictEqual(new Map([[1, { x: 1 }]]), new Map([[1, { x: 1 }]]));
assert.notStrictEqual(1, 2);
assert.throws(() => {
  throw new TypeError("bad");
}, TypeError);
assert.match("abc", /b/);
for (const [name, fn] of [
  ["strictEqual", () => assert.strictEqual(1, 2)],
  ["deepStrictEqual", () => assert.deepStrictEqual({ a: 1 }, { a: 2 })],
  ["ok", () => assert.ok(false, "custom message")],
  ["throws", () => assert.throws(() => {})],
  ["fail", () => assert.fail("explicit")],
]) {
  try {
    fn();
    console.log(name, "did not throw");
  } catch (err) {
    console.log(name, "->", err.name, err.code, err instanceof assert.AssertionError, name === "ok" || name === "fail" ? err.message : "");
  }
}
assert.rejects(Promise.reject(new Error("r"))).then(() => console.log("rejects ok"));
console.log("strict:", typeof assert.strict, typeof require("assert/strict").deepEqual);
