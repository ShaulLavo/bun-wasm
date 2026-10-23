import assert from "node:assert/strict";
import { JSONL } from "bun";

const complete = ['{}', '[]', '{"a":[1,{"b":true}]}', '"a\\u00e9"', 'true', 'false', 'null', '-1.25e+2'];
for (const text of complete) assert.deepEqual(JSONL.parse(text), [JSON.parse(text)]);
for (const text of ['{', '[1,', '{"a":', '-', '"a\\', '1.']) {
  const part = JSONL.parseChunk(text);
  assert.equal(part.done, false);
  assert.equal(part.error, null);
}
for (const text of ['{bad}', '"a\\q"', '"a\n"']) {
  const part = JSONL.parseChunk(text);
  assert.equal(part.done, false);
  assert.equal(part.error?.message, "Failed to parse JSONL");
}
console.log("JSONL scalar, nested, partial and invalid tokens");

const bytes = new TextEncoder().encode('﻿{"é":1}\n[true,');
const partial = JSONL.parseChunk(bytes);
assert.deepEqual(partial.values, [{ é: 1 }]);
assert.equal(partial.read, 11);
assert.equal(partial.done, false);
const padded = new Uint8Array(bytes.length + 8);
padded.set(bytes, 4);
assert.deepEqual(JSONL.parseChunk(padded.subarray(4, -4)), partial);
assert.deepEqual(JSONL.parseChunk(padded, 7, padded.length - 4).values, [{ é: 1 }]);
assert.deepEqual(JSONL.parseChunk('xxtrue\n7yy', 2.9, 8.9), { values: [true, 7], read: 8, done: true, error: null });
assert.deepEqual(JSONL.parseChunk('true', 4, 1).values, []);
assert.deepEqual(JSONL.parseChunk('true', NaN, Infinity).values, [true]);
assert.deepEqual(JSONL.parseChunk({ toString: () => "null\n7" }).values, [null, 7]);
assert.deepEqual(JSONL.parseChunk(new DataView(new ArrayBuffer(0))).values, []);
assert.equal(JSONL.parseChunk('1\r\n2\r\n').read, 4);
assert.throws(() => JSONL.parse(null), TypeError);
assert.throws(() => JSONL.parseChunk(undefined), TypeError);
assert.deepEqual(JSONL.parse('true invalid'), [true]);
assert.equal(Object.prototype.toString.call(JSONL), "[object JSONL]");
console.log("JSONL byte views, BOM, offsets, coercion and errors");
