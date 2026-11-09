// SharedArrayBuffer slice behaviour that must hold on every engine: exact lengths, independent
// destination bytes, and refusal of a species result over the source's own shared block.
import { strict as assert } from 'node:assert';

const bytes = (buffer: SharedArrayBuffer) => new Uint8Array(buffer);

function assertIndependentSlice(source: SharedArrayBuffer, start: number, end: number) {
  const before = bytes(source).slice();
  const part = source.slice(start, end);
  assert.ok(part instanceof SharedArrayBuffer);
  assert.notEqual(part, source);
  assert.equal(part.byteLength, Math.max(end - start, 0));
  assert.deepEqual(bytes(part), before.subarray(start, end));
  bytes(part).fill(0xee);
  assert.deepEqual(bytes(source), before);
}

const small = new SharedArrayBuffer(10);
bytes(small).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assertIndependentSlice(small, 2, 7);
assertIndependentSlice(small, 3, 3);
assertIndependentSlice(small, 0, 10);

const large = new SharedArrayBuffer(70_000);
bytes(large)[69_999] = 77;
assertIndependentSlice(large, 69_000, 70_000);

class Derived extends SharedArrayBuffer {}
const derived = new Derived(8).slice(1, 4);
assert.ok(derived instanceof Derived);
assert.equal(derived.byteLength, 3);

function withSpecies(source: SharedArrayBuffer, result: () => SharedArrayBuffer) {
  const constructor = function () { return result(); };
  Object.defineProperty(source, 'constructor', { value: { [Symbol.species]: constructor } });
}

const independent = new SharedArrayBuffer(4);
bytes(independent).set([1, 2, 3, 4]);
const destination = new SharedArrayBuffer(4);
withSpecies(independent, () => destination);
assert.equal(independent.slice(0, 4), destination);
assert.deepEqual(bytes(destination), new Uint8Array([1, 2, 3, 4]));

console.log('shared-buffer slice: pass');
