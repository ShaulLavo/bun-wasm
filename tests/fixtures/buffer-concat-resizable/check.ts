import assert from "node:assert/strict";

export function checkResizableConcat(factory: typeof Buffer) {
  const backing = new ArrayBuffer(8, { maxByteLength: 16 });
  const first = factory.from(backing).fill(0xaa);
  const list = [first, factory.alloc(0)];
  let calls = 0;
  Object.defineProperty(list, 1, { get() { calls++; backing.resize(3); return factory.alloc(0); } });
  assert.equal(factory.concat(list).toString("hex"), "aaaaaa");
  assert.equal(calls, 1);
  assert.equal(factory.concat(list, 5).toString("hex"), "aaaaaa0000");
}
