// A species result over the source's own shared block is refused before any byte moves, even
// when it is a different wrapper with a different length. Only group guests reject this today:
// the JSC that native Bun ships compares wrappers.
import { strict as assert } from 'node:assert';

const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const old = memory.buffer as SharedArrayBuffer;
memory.grow(1);
const current = memory.buffer as SharedArrayBuffer;
assert.notEqual(old, current);
const view = new Uint8Array(old);
view.set([1, 2, 3, 4]);

const species = Object.getOwnPropertyDescriptor(SharedArrayBuffer, Symbol.species)!;
Object.defineProperty(SharedArrayBuffer, Symbol.species, { configurable: true, value: function () { return current; } });
try {
  for (const [start, end] of [[1, 4], [2, 2]]) {
    assert.throws(() => old.slice(start, end), TypeError);
    assert.deepEqual(view.subarray(0, 4), new Uint8Array([1, 2, 3, 4]));
  }
} finally {
  Object.defineProperty(SharedArrayBuffer, Symbol.species, species);
}
console.log('shared-buffer alias: pass');
