// A module that exports its function table and no global: the shape of an emnapi binding, which
// calls its callbacks through `__indirect_function_table`. Standard WebAssembly behaviour that
// native Bun also shows, so it runs unchanged on both hosts.
import { strict as assert } from 'node:assert';

const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/table-controls.wasm`).arrayBuffer());
let doubled = 0;
function double(value: number) {
  doubled += 1;
  return value * 2;
}
function create(callback: (value: number) => number = double) {
  return new WebAssembly.Instance(module, { env: { memory, first: (left: number, right: number) => left * right, callback } });
}
function fn(instance: WebAssembly.Instance, name: string): CallableFunction {
  const value = instance.exports[name];
  if (typeof value !== 'function') throw new Error(`Missing ${name}`);
  return value;
}
function table(instance: WebAssembly.Instance, name = 'table') {
  const value = instance.exports[name];
  if (!(value instanceof WebAssembly.Table)) throw new Error(`Missing ${name}`);
  return value;
}
function entry(entries: WebAssembly.Table, index: number): CallableFunction {
  const value: unknown = entries.get(index);
  if (typeof value !== 'function') throw new Error(`Missing entry ${index}`);
  return value;
}

const kinds = WebAssembly.Module.exports(module).map(item => item.kind);
assert.equal(kinds.filter(kind => kind === 'table').length, 2);
assert.equal(kinds.includes('global'), false);

// One table under both names, and an entry is the function its export names.
const first = create();
const entries = table(first);
assert.equal(entries, table(first, '__indirect_function_table'));
assert.equal(entries.length, 6);
const add = fn(first, 'add'), call = fn(first, 'call');
assert.equal(entries.get(0), add);
assert.equal(entries.get(5), null);

// An unexported entry is one function with its own exact type.
const hidden = entry(entries, 1);
assert.notEqual(hidden, add);
assert.equal(entries.get(1), hidden);
assert.equal(hidden(9, 4), 5);
const wide = entry(entries, 3);
assert.equal(wide(-5n, 3), -2n);
assert.equal(wide(2n ** 40n, 1), 2n ** 40n + 1n);

// Imported callbacks kept in the table are called with their import's type.
const kept = entry(entries, 2);
assert.equal(kept(2.5), 5);
assert.equal(doubled, 1);
assert.equal(entry(entries, 4)(6, 7), 42);
assert.equal(call(4, 6, 7), 42);
const failure = new Error('callback failure');
const failing = create(() => { throw failure; });
assert.throws(() => entry(table(failing), 2)(1), (error: unknown) => error === failure);
assert.equal(kept(1.5), 3);

// A write from JS is what the instance's own call_indirect runs, with its real signature.
assert.throws(() => call(5, 9, 4), WebAssembly.RuntimeError);
entries.set(5, hidden);
assert.equal(entries.get(5), hidden);
assert.equal(call(5, 9, 4), 5);
entries.set(5, wide);
assert.throws(() => call(5, 9, 4), WebAssembly.RuntimeError);
entries.set(5, null);
assert.equal(entries.get(5), null);
assert.throws(() => call(5, 9, 4), WebAssembly.RuntimeError);

// A write from the instance is what JS reads next.
fn(first, 'clearEntry')(0);
assert.equal(entries.get(0), null);
fn(first, 'storeHidden')(0);
assert.equal(entries.get(0), hidden);

assert.throws(() => entries.get(6), RangeError);
assert.throws(() => entries.set(6, add), RangeError);
assert.throws(() => entries.set(0, () => 1), TypeError);
assert.throws(() => entries.set(0, {} as never), TypeError);
assert.equal(entries.get(0), hidden);

assert.equal(entries.grow(1), 6);
assert.equal(entries.get(6), null);
assert.equal(entries.grow(1, add), 7);
assert.equal(entries.get(7), add);
assert.equal(call(7, 3, 4), 7);
assert.throws(() => entries.grow(1), RangeError);
assert.equal(entries.length, 8);

// Each instance has its own table and functions, and a function can be kept in another's table.
const second = create();
const others = table(second);
assert.notEqual(others, entries);
assert.notEqual(fn(second, 'add'), add);
assert.equal(others.length, 6);
others.set(5, hidden);
assert.equal(others.get(5), hidden);
assert.equal(fn(second, 'call')(5, 9, 4), 5);
assert.equal(entries.length, 8);

// The same instances still use their shared memory.
new Uint8Array(memory.buffer)[3] = 9;
assert.equal(fn(first, 'touch')(3), 9);
assert.equal(fn(second, 'touch')(3), 9);

console.log('shared-wasm-memory table exports: pass');
