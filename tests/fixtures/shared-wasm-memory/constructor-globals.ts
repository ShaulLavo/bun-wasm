import { strict as assert } from 'node:assert';
import './global-controls.ts';
async function load(name: string) {
  return new WebAssembly.Module(await Bun.file(`${import.meta.dir}/${name}.wasm`).arrayBuffer());
}
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const bytes = new Uint8Array(memory.buffer);
for (const type of ['i32', 'i64', 'f32', 'f64'] satisfies WebAssembly.ValueType[]) {
  const created = new WebAssembly.Global({ value: type }, type === 'i64' ? 7n : 7);
  const reexport = await load(`global-reexport-${type}`);
  const first = new WebAssembly.Instance(reexport, { env: { g: created } });
  const second = new WebAssembly.Instance(reexport, { env: { g: first.exports.alias } });
  assert.equal(first.exports.g, created);
  assert.equal(first.exports.alias, created);
  assert.equal(second.exports.g, created);
  const consumer = await load(`global-cross-${type}`);
  for (const g of [created, first.exports.g, second.exports.alias]) {
    assert.throws(() => new WebAssembly.Instance(consumer, { env: { memory, g } }), (error: unknown) => {
      assert(error instanceof WebAssembly.LinkError);
      assert.match(error.message, /Constructor-created WebAssembly globals cannot cross backends/);
      return true;
    });
    assert.equal(bytes[0], 0, 'cross-backend rejection precedes start writes');
  }
}
for (const type of ['externref', 'funcref', 'anyfunc', 'v128']) {
  assert.throws(() => Reflect.construct(WebAssembly.Global, [{ value: type }]), TypeError);
}
const mutableImport = await Bun.file(`${import.meta.dir}/mutable-global-import.wasm`).arrayBuffer();
assert.throws(() => new WebAssembly.Module(mutableImport), WebAssembly.CompileError);
console.log('shared-wasm-memory partial numeric Global constructor: pass');
