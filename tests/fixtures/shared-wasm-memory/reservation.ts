// Group-guest admission of shared memories whose declared maximum is larger than the storage the
// group selects. These limits are host resources, so only guest.ts runs this file.
import { strict as assert } from 'node:assert';

const PAGE = 65536;
type Exports = { pages(): number; grow(delta: number): number; read(address: number): number };

const imported = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/reservation.wasm`).arrayBuffer());
const smallLimit = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/imported.wasm`).arrayBuffer());

function fullMaximumThatFitsStillGrows() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2048, shared: true });
  const old = memory.buffer;
  new Uint8Array(old)[0] = 77;
  assert.equal(memory.grow(2047), 1);
  assert.equal(memory.buffer.byteLength, 2048 * PAGE);
  assert.equal(old.byteLength, PAGE);
  assert.equal(new Uint8Array(old)[0], 77);
  assert.equal(new Uint8Array(memory.buffer)[2048 * PAGE - 1], 0);
}

function refusedJsGrowth(memory: WebAssembly.Memory, delta: number, pages: number, buffer: ArrayBufferLike) {
  assert.throws(() => memory.grow(delta), RangeError);
  assert.equal(memory.buffer, buffer);
  assert.equal(memory.buffer.byteLength, pages * PAGE);
}

function jsGrowthPath() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
  const before = memory.buffer;
  new Uint8Array(before)[0] = 41;
  // The maximum allows this, the selected reservation does not, and room is still left.
  refusedJsGrowth(memory, 4000, 1, before);
  assert.equal(new Uint8Array(before)[0], 41);
  assert.equal(memory.grow(2), 1);
  assert.equal(memory.buffer.byteLength, 3 * PAGE);
  assert.equal(new Uint8Array(before)[0], 41);
  assert.equal(new Uint8Array(memory.buffer)[3 * PAGE - 1], 0);
  assert.equal(before.byteLength, PAGE);
}

function nestedGrowthPath() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
  const exports = new WebAssembly.Instance(imported, { env: { memory } }).exports as unknown as Exports;
  const before = memory.buffer;
  new Int32Array(before)[0] = 41;
  assert.equal(exports.grow(4000), -1);
  assert.equal(exports.pages(), 1);
  assert.equal(memory.buffer, before);
  assert.equal(exports.read(0), 41);
  assert.equal(exports.grow(2), 1);
  assert.equal(exports.pages(), 3);
  assert.equal(memory.buffer.byteLength, 3 * PAGE);
  assert.equal(exports.read(0), 41);
  assert.equal(new Int32Array(before)[0], 41);
}

function fillingTheBound() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 8, shared: true });
  const exports = new WebAssembly.Instance(imported, { env: { memory } }).exports as unknown as Exports;
  assert.equal(memory.grow(3), 1);
  assert.equal(exports.grow(4), 4);
  const full = memory.buffer;
  assert.equal(full.byteLength, 8 * PAGE);
  assert.equal(exports.grow(1), -1);
  refusedJsGrowth(memory, 1, 8, full);
  assert.equal(exports.grow(0), 8);
  assert.equal(memory.grow(0), 8);
  assert.equal(memory.buffer.byteLength, 8 * PAGE);
}

function declaredLimitsAreStillMatched() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
  const exports = new WebAssembly.Instance(imported, { env: { memory } }).exports as unknown as Exports;
  assert.equal(exports.pages(), 1);
  assert.throws(() => new WebAssembly.Instance(smallLimit, { env: { memory, observe() {} } }), WebAssembly.LinkError);
}

fullMaximumThatFitsStillGrows();
jsGrowthPath();
nestedGrowthPath();
fillingTheBound();
declaredLimitsAreStillMatched();
console.log('shared-wasm-memory reservation: pass');
