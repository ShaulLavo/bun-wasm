import { strict as assert } from 'node:assert';

const shared = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/imported.wasm`).arrayBuffer());
const plain = new WebAssembly.Instance(new WebAssembly.Module(await Bun.file(`${import.meta.dir}/unshared.wasm`).arrayBuffer()));
const noop = plain.exports.noop;
assert.equal(typeof noop, 'function');
if (typeof noop !== 'function') throw new Error('Missing Wasmi export');
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
assert.throws(() => new WebAssembly.Instance(shared, { env: { memory, observe: noop } }), WebAssembly.LinkError);
console.log('shared-wasm-memory mixed-backend rejection: pass');
