import { strict as assert } from 'node:assert';
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/duplicate-imports.wasm`).arrayBuffer());
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
let reads = 0;
const instance = new WebAssembly.Instance(module, { env: { memory, get value() {
  reads++;
  return reads === 1 ? (n: number) => 100 + n : (n: number) => 200 + n;
} } });
const first = instance.exports.first, second = instance.exports.second;
if (typeof first !== 'function' || typeof second !== 'function') throw new Error('Missing exports');
const observed = [first(), second()];
assert.equal(reads, 2);
assert.deepEqual(observed, [101, 202]);
console.log('shared-wasm-memory duplicate imports: pass');
