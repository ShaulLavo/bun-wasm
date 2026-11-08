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
const typed = await load('typed-import');
const exporter = new WebAssembly.Instance(await load('imported'), { env: { memory, observe() {} } });
const wrong = fn(exporter, 'callback');
assert.throws(() => new WebAssembly.Instance(typed, { env: { memory, observe() {} } }), WebAssembly.LinkError);
assert.throws(() => new WebAssembly.Instance(typed, { env: { memory, observe() {}, peer: 0 } }), WebAssembly.LinkError);
for (let attempt = 0; attempt < 5000; attempt++) {
  assert.throws(() => new WebAssembly.Instance(typed, { env: { memory, observe() {}, peer: wrong } }), WebAssembly.LinkError);
}
const linked = new WebAssembly.Instance(typed, { env: { memory, observe() {}, peer: (value: bigint) => value + 1n } });
assert.equal(fn(linked, 'go')(41n), 42n);
const thrown = { identity: 'start callback' };
const start = await load('start');
assert.throws(() => new WebAssembly.Instance(start, { env: { memory, observe() { throw thrown; } } }), error => error === thrown);
new WebAssembly.Instance(start, { env: { memory, observe() {} } });
assert.equal(fn(linked, 'go')(43n), 44n);
console.log('shared-wasm-memory link recovery: pass');
