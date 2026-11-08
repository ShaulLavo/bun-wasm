import { strict as assert } from 'node:assert';

// The Browser host has no Wasmtime Store and no instance ceiling for it. A failed start still must
// not retain anything: this runs far more failed starts than the native budget allows.
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/imported.wasm`).arrayBuffer());
const trap = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/start-trap.wasm`).arrayBuffer());
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const instance = new WebAssembly.Instance(module, { env: { memory, observe() {} } });
const read = instance.exports.read;
if (typeof read !== 'function') throw new Error('Missing shared export');
const words = new Int32Array(memory.buffer);
Atomics.store(words, 0, 73);
for (let attempt = 0; attempt < 5000; attempt++) {
  assert.throws(() => new WebAssembly.Instance(trap), WebAssembly.RuntimeError);
}
const fresh = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
assert.equal(fresh.buffer.byteLength, 65536);
assert.equal(fresh.grow(1), 1);
assert.equal(read(), 73);
assert.equal(memory.grow(1), 1);
assert.equal(read(), 73);
console.log('shared-wasm-memory Browser budget: pass');
