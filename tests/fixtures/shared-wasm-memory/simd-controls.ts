import { strict as assert } from 'node:assert';

async function load(name: string) {
  return new WebAssembly.Module(await Bun.file(`${import.meta.dir}/${name}.wasm`).arrayBuffer());
}
function fn(instance: WebAssembly.Instance, name: string) {
  const value = instance.exports[name];
  if (typeof value !== 'function') throw new Error(`Missing export ${name}`);
  return value;
}
const simd = new WebAssembly.Instance(await load('v128-export'));
assert.equal(fn(simd, 'ok')(), 1);
assert.throws(() => fn(simd, 'parameter')(0), TypeError);
assert.throws(() => fn(simd, 'result')(), TypeError);
assert.equal(fn(simd, 'ok')(), 1);
console.log('shared-wasm-memory SIMD boundary: pass');
