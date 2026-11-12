// Runs alone in its own guest: most of the group's room is taken here. Stock Rolldown's 1 GiB of
// initial bytes fit a 2 GiB group beside its member although its declared maximum cannot, and
// initial bytes that do not fit are never clamped.
import { strict as assert } from 'node:assert';

const PAGE = 65536;
const ROLLDOWN = { initial: 16384, maximum: 65536, shared: true } as const;
const memory = new WebAssembly.Memory(ROLLDOWN);
assert.equal(memory.buffer.byteLength, 16384 * PAGE);
const bytes = new Uint8Array(memory.buffer);
bytes[16384 * PAGE - 1] = 9;
assert.equal(bytes[16384 * PAGE - 1], 9);
// A second one is refused whole, and so is an initial size no group could hold.
assert.throws(() => new WebAssembly.Memory(ROLLDOWN), RangeError);
assert.throws(() => new WebAssembly.Memory({ initial: 32768, maximum: 65536, shared: true }), RangeError);
assert.equal(memory.buffer.byteLength, 16384 * PAGE);
assert.equal(bytes[16384 * PAGE - 1], 9);
console.log('shared-wasm-memory reservation capacity: pass');
