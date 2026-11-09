// Runs alone in its own guest: most of the group's room is taken here. Initial bytes that fit are
// admitted when the declared maximum cannot, and initial bytes that do not fit are never clamped.
import { strict as assert } from 'node:assert';

const PAGE = 65536;
assert.throws(() => new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true }), RangeError);
const memory = new WebAssembly.Memory({ initial: 14000, maximum: 65536, shared: true });
assert.equal(memory.buffer.byteLength, 14000 * PAGE);
const bytes = new Uint8Array(memory.buffer);
bytes[14000 * PAGE - 1] = 9;
assert.equal(bytes[14000 * PAGE - 1], 9);
console.log('shared-wasm-memory reservation capacity: pass');
