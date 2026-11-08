// Group-guest limits on nested tables and globals. Native Bun allows or clones these differently.
import { strict as assert } from 'node:assert';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
async function bytes(name: string) { return Bun.file(`${import.meta.dir}/${name}.wasm`).arrayBuffer(); }
const module = new WebAssembly.Module(await bytes('table-global'));
const instance = new WebAssembly.Instance(module, { env: { memory, base: 5, base2: 6 } });
const table = instance.exports.table as WebAssembly.Table;
const global = instance.exports.answer as WebAssembly.Global;

// The JS API caches a Global by its underlying global. Native Bun does not, so it is no reference.
function create(base: number | WebAssembly.Global, base2: number | WebAssembly.Global) {
  return new WebAssembly.Instance(module, { env: { memory, base, base2 } });
}
const imported = (target: WebAssembly.Instance, name: string) => target.exports[name] as WebAssembly.Global;
assert.equal(global, instance.exports.answerAlias);
// The JS API requires TypeError here. Native Bun throws RuntimeError.
assert.throws(() => (instance.exports.vector as WebAssembly.Global).value, TypeError);
const raw = create(5, 5);
assert.equal(imported(raw, 'importedBase').value, 5);
assert.equal(imported(raw, 'importedBase'), imported(raw, 'importedBaseAlias'));
assert.notEqual(imported(raw, 'importedBase'), imported(raw, 'importedBase2'));
assert.notEqual(imported(raw, 'importedBase'), imported(create(5, 5), 'importedBase'));
const reexport = create(global, global);
assert.equal(imported(reexport, 'importedBase'), global);
assert.equal(imported(reexport, 'importedBaseAlias'), global);
assert.equal(imported(reexport, 'importedBase2'), global);
assert.equal(imported(create(global, 6), 'importedBase'), global);
assert.notEqual(imported(create(global, 6), 'importedBase2'), global);

for (const name of ['table-externref', 'global-reference']) {
  const source = await bytes(name);
  assert.throws(() => new WebAssembly.Module(source), WebAssembly.CompileError);
  assert.equal(WebAssembly.validate(source), false);
}

const unshared = new WebAssembly.Instance(new WebAssembly.Module(await bytes('unshared')));
const wasmi = Object.values(unshared.exports).find(value => typeof value === 'function') as CallableFunction;
assert.throws(() => table.set(0, wasmi), TypeError);
assert.throws(() => table.grow(1, wasmi), TypeError);

function refused(operation: () => void) {
  assert.throws(operation, (error: Error) => error.name === 'DataCloneError');
}
const child = `${import.meta.dir}/plain-sab-child.ts`;
for (const value of [table, global]) {
  refused(() => structuredClone(value));
  refused(() => structuredClone({ fresh: new SharedArrayBuffer(8), value }));
  refused(() => new Worker(child, { workerData: { mode: 'creator', value } }));
  const { port1, port2 } = new MessageChannel();
  refused(() => port1.postMessage({ value }));
  // A fresh buffer visited first must not stay published, past the directory's own limit.
  for (let round = 0; round < 4200; round += 1) {
    refused(() => port1.postMessage({ fresh: new SharedArrayBuffer(8), value }));
  }
  const later = new SharedArrayBuffer(8);
  port1.postMessage(later);
  new Uint8Array(later)[0] = 3;
  assert.equal(new Uint8Array(receiveMessageOnPort(port2)!.message)[0], 3);
  port1.close();
  port2.close();
}
console.log('table-global guest: pass');
