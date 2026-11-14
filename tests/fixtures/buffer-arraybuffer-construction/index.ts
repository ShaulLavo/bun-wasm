import { strict as assert } from "node:assert";

const backing = new ArrayBuffer(9);
const remaining = Buffer.from(backing, 2);
const fixed = Buffer.from(backing, 2, 3);
assert.equal(remaining.length, 7);
assert.equal(fixed.length, 3);
assert.equal(remaining.buffer, backing);
assert.equal(fixed.buffer, backing);
remaining[0] = 0x41;
assert.equal(fixed[0], 0x41);
fixed[2] = 0x42;
assert.equal(new Uint8Array(backing)[4], 0x42);

const calls: string[] = [];
assert.throws(() => Reflect.apply(Buffer.from, Buffer, [
  backing,
  { valueOf() { calls.push("offset"); return -1; } },
  { valueOf() { calls.push("length"); return 0; } },
]), { name: "RangeError", code: "ERR_BUFFER_OUT_OF_BOUNDS" });
assert.deepEqual(calls, ["offset"]);
console.log("Buffer ArrayBuffer construction checks passed");
