import { strict as assert } from 'node:assert';

const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/imported.wasm`).arrayBuffer());
const trap = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/start-trap.wasm`).arrayBuffer());
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const instance = new WebAssembly.Instance(module, { env: { memory, observe() {} } });
const read = instance.exports.read;
assert.equal(typeof read, 'function');
if (typeof read !== 'function') throw new Error('Missing shared export');
const words = new Int32Array(memory.buffer);
Atomics.store(words, 0, 73);

function attempt(): 'trap' | 'limit' {
  try { new WebAssembly.Instance(trap); }
  catch (error) {
    if (error instanceof WebAssembly.RuntimeError) return 'trap';
    assert(error instanceof WebAssembly.LinkError);
    assert.match(error.message, /instance count/);
    return 'limit';
  }
  throw new Error('The start trap unexpectedly succeeded');
}
let exhausted = false;
for (let attemptIndex = 0; attemptIndex < 64; attemptIndex++) {
  if (attempt() !== 'limit') continue;
  exhausted = true;
  break;
}
assert(exhausted, 'The unchanged native Store instance bound must apply');
for (let index = 0; index < 5000; index++) assert.equal(attempt(), 'limit');
const fresh = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
assert.equal(fresh.buffer.byteLength, 65536);
assert.equal(fresh.grow(1), 1);
assert.equal(read(), 73);
assert.equal(Atomics.load(words, 0), 73);
assert.equal(memory.grow(1), 1);
assert.equal(read(), 73);
console.log('shared-wasm-memory Store budget: pass');
