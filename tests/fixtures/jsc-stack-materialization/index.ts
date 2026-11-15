import assert from "node:assert/strict";

const saved = Error.prepareStackTrace;
const limit = Error.stackTraceLimit;
try {
  Error.stackTraceLimit = 1;
  function rawError() { return Function('return new Error("native default")')(); }
  const live = rawError().stack;
  const cached = rawError();
  Bun.gc(true);
  Bun.gc(true);
  assert.equal(cached.stack, live);
  console.log("native text unchanged after collection");

  const collected = Function("return new Error()")();
  let calls = 0;
  const marker = {};
  Error.prepareStackTrace = function (error, sites) {
    assert.equal(this, Error);
    assert.equal(error, collected);
    assert.ok(Array.isArray(sites));
    calls++;
    return marker;
  };
  Bun.gc(true);
  Bun.gc(true);
  assert.equal(calls, 0);
  assert.equal(collected.stack, marker);
  assert.equal(collected.stack, marker);
  assert.equal(calls, 1);
  console.log("collected stack formats once on access");

  Error.stackTraceLimit = 0;
  const empty = new Error();
  calls = 0;
  Error.prepareStackTrace = function (error, sites) {
    assert.equal(this, Error);
    assert.equal(error, empty);
    assert.deepEqual(sites, []);
    calls++;
    return marker;
  };
  assert.equal(calls, 0);
  assert.equal(empty.stack, marker);
  assert.equal(empty.stack, marker);
  assert.equal(calls, 1);
  console.log("empty stack formats once on access");

  Error.prepareStackTrace = saved;
  const plain = new Error();
  assert.equal(plain.stack, undefined);
  assert.equal(Object.hasOwn(plain, "stack"), false);
  console.log("empty native stack remains absent without a hook");
} finally {
  Error.prepareStackTrace = saved;
  Error.stackTraceLimit = limit;
}
