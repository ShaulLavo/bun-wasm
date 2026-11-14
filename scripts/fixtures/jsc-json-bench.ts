import assert from "node:assert/strict";
import { readSync } from "node:fs";
function checkpoint(label: string) {
  process.stdout.write("json-checkpoint " + label + "\n");
  assert.equal(readSync(0, Buffer.alloc(1), 0, 1, null), 1);
}
const name = process.argv[2];
const count = name === "small" ? 100 : name === "medium" ? 5000 : name === "wide" ? 20000 : 0;
assert.ok(count);
const document = Array.from({ length: count }, (_, i) => ({ id: i, name: `item ${i}`, ok: i % 2 === 0 }));
const length = JSON.stringify(document).length;
let checksum = 0;
function serialize(iterations: number): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) checksum += JSON.stringify(document).length;
  return performance.now() - start;
}
let iterations = Number(process.argv[3]);
if (!iterations) {
  iterations = 1;
  while (serialize(iterations) < 200) iterations *= 2;
  iterations *= 10;
}
serialize(Math.max(1, Math.ceil(iterations / 10)));
Bun.gc(true);
checkpoint("start");
const elapsedMs = serialize(iterations);
checkpoint("end");
assert.ok(checksum > iterations * length);
console.log("json-bench " + JSON.stringify({ name, iterations, elapsedMs, length, checksum }));
