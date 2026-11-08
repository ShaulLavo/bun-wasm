import { strict as assert } from 'node:assert';

async function load(name: string) {
  return new WebAssembly.Module(await Bun.file(`${import.meta.dir}/${name}.wasm`).arrayBuffer());
}
function fn(instance: WebAssembly.Instance, name: string) {
  const value = instance.exports[name];
  if (typeof value !== 'function') throw new Error(`Missing export ${name}`);
  return value;
}
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const module = await load('globals-import');
const source = new WebAssembly.Instance(await load('global-source'));
const defaults = { memory, i: 1, l: 2n, f: 3, s: 4 };
for (const invalid of [
  { i: undefined }, { f: undefined }, { s: undefined }, { l: undefined },
  { i: '5' }, { i: true }, { f: '5' }, { f: false }, { s: '5' },
  { l: 5 }, { i: 5n }, { f: 5n }, { s: 5n },
  { i: Object.create(WebAssembly.Global.prototype) }, { i: new Number(5) },
  { f: source.exports.i }, { i: source.exports.f }, { i: source.exports.mutable },
]) {
  assert.throws(() => new WebAssembly.Instance(module, { env: { ...defaults, ...invalid } }), WebAssembly.LinkError);
}
const valid = new WebAssembly.Instance(module, { env: { ...defaults, i: source.exports.i, f: source.exports.f } });
assert.equal(fn(valid, 'i')(), 7);
assert.equal(fn(valid, 'f')(), 1.25);
assert.equal(fn(valid, 'l')(), 2n);
assert.equal(fn(valid, 's')(), 4);
const unshared = await load('unshared-global');
for (const l of [undefined, 5, true, '5']) {
  assert.throws(() => new WebAssembly.Instance(unshared, { env: { l } }), WebAssembly.LinkError);
}
console.log('shared-wasm-memory Global validation: pass');
