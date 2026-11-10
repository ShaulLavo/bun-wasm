// Runs alone in its own guest. This is the descriptor the published
// @oxc-parser/binding-wasm32-wasi 0.94.0 loader constructs: its 4 GiB maximum cannot fit a 1 GiB
// group and its 250 MiB of initial bytes can. Its module imports a 65536-page shared memory, as
// reservation.wasm does. This controls that capability only; it does not load the package.
import { strict as assert } from 'node:assert';

const PAGE = 65536;
const INITIAL = 4000;
type Exports = { pages(): number; grow(delta: number): number; read(address: number): number };

const memory = new WebAssembly.Memory({ initial: INITIAL, maximum: 65536, shared: true });
const before = memory.buffer;
assert.ok(before instanceof SharedArrayBuffer);
assert.equal(before.byteLength, INITIAL * PAGE);
const words = new Int32Array(before);
const last = INITIAL * PAGE / 4 - 1;
Atomics.store(words, last, 94);

const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/reservation.wasm`).arrayBuffer());
const exports = new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as Exports;
assert.equal(exports.pages(), INITIAL);
assert.equal(exports.read(last * 4), 94);

// The declared maximum allows these and the selected reservation does not. Nothing changes.
assert.throws(() => memory.grow(INITIAL), RangeError);
assert.equal(exports.grow(INITIAL), -1);
assert.equal(memory.buffer, before);
assert.equal(exports.pages(), INITIAL);

// Growth inside the reservation keeps the old buffer a live prefix of the same bytes.
assert.equal(memory.grow(1), INITIAL);
assert.equal(exports.pages(), INITIAL + 1);
assert.equal(memory.buffer.byteLength, (INITIAL + 1) * PAGE);
assert.equal(before.byteLength, INITIAL * PAGE);
Atomics.store(new Int32Array(memory.buffer), last, 95);
assert.equal(Atomics.load(words, last), 95);
assert.equal(exports.read((INITIAL + 1) * PAGE - 4), 0);

// Initial bytes are never clamped: a 1 GiB initial size still cannot share the group.
assert.throws(() => new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true }), RangeError);
console.log('shared-wasm-memory binding descriptor: pass');
