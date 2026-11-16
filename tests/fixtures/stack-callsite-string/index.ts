import assert from "node:assert/strict";
const saved = Error.prepareStackTrace;
let calls = 0;
try {
  Error.prepareStackTrace = (_error, sites) => {
    calls++;
    const site = sites.find(site => site.getFunctionName()?.endsWith("namedStringControl"));
    assert(site);
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(site), "toString");
    assert(descriptor);
    assert.equal(descriptor.enumerable, false);
    if (process.env.BUNWASM_TEST_HOST === "native") {
      assert.equal(descriptor.configurable, true);
      assert.equal(descriptor.writable, true);
    }
    assert.equal(typeof descriptor.value, "function");
    const text = site.toString();
    assert.equal(String(site), text);
    assert(text.includes("namedStringControl"));
    assert(text.includes("/index.ts:"));
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(site), "toString"), descriptor);
    return { text };
  };
  function namedStringControl() { return new Error("string control"); }
  const error = namedStringControl();
  const first = error.stack;
  assert.equal(error.stack, first);
  assert.equal(calls, 1);
} finally { Error.prepareStackTrace = saved; }
console.log("Custom CallSite toString and String preserve descriptors, positions and lazy identity");
