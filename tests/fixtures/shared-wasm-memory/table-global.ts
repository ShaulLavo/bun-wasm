// Exported tables and globals, on standard WebAssembly behaviour that native Bun also shows.
import { strict as assert } from 'node:assert';

const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/table-global.wasm`).arrayBuffer());
type Numeric = number | WebAssembly.Global;
function create(base: Numeric, base2: Numeric) {
  return new WebAssembly.Instance(module, { env: { memory, base, base2 } });
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
function global(instance: WebAssembly.Instance, name: string) {
  const value = instance.exports[name];
  if (!(value instanceof WebAssembly.Global)) throw new Error(`Missing ${name}`);
  return value;
}

const shapes = new Map(WebAssembly.Module.exports(module).map(item => [item.name, item.kind]));
assert.equal(shapes.get('table'), 'table');
assert.equal(shapes.get('answer'), 'global');

const first = create(5, 6);
const entries = table(first);
assert.equal(entries, table(first, '__indirect_function_table'));
assert.equal(entries.length, 4);
const add = fn(first, 'add'), mul = fn(first, 'mul'), call = fn(first, 'call');
assert.equal(entries.get(0), add);
assert.equal(entries.get(2), mul);
assert.equal(entries.get(1), null);
assert.equal(entries.get(3), null);
assert.equal(call(0, 3, 4), 7);
assert.equal(call(2, 3, 4), 12);
assert.equal((entries.get(2) as CallableFunction)(5, 6), 30);
assert.throws(() => call(1, 3, 4), WebAssembly.RuntimeError);

entries.set(1, add);
assert.equal(call(1, 3, 4), 7);
assert.equal(entries.get(1), add);
entries.set(1, null);
assert.equal(entries.get(1), null);
assert.throws(() => call(1, 3, 4), WebAssembly.RuntimeError);
assert.throws(() => entries.get(4), RangeError);
assert.throws(() => entries.set(4, add), RangeError);
assert.throws(() => entries.set(0, () => 1), TypeError);
assert.throws(() => entries.set(0, {} as never), TypeError);

fn(first, 'clearEntry')(0);
assert.equal(entries.get(0), null);
fn(first, 'restoreAdd')(0);
assert.equal(entries.get(0), add);

assert.equal(entries.grow(1), 4);
assert.equal(entries.length, 5);
assert.equal(entries.get(4), null);
assert.equal(entries.grow(1, add), 5);
assert.equal(entries.get(5), add);
assert.throws(() => entries.grow(3), RangeError);
assert.equal(entries.length, 6);

const answer = global(first, 'answer');
assert.equal(answer.value, 42);
assert.equal(answer.valueOf(), 42);
assert.throws(() => { answer.value = 1; }, TypeError);
const counter = global(first, 'counter');
assert.equal(counter.value, 7);
counter.value = 9;
assert.equal(fn(first, 'getCounter')(), 9);
fn(first, 'setCounter')(11);
assert.equal(counter.value, 11);
const wide = global(first, 'wide');
assert.equal(wide.value, 9n);
wide.value = -5n;
assert.equal(wide.value, -5n);
assert.equal(global(first, 'float').value, 1.5);

const second = create(5, 6);
assert.notEqual(table(second), entries);
assert.notEqual(fn(second, 'add'), add);
assert.equal(table(second).length, 4);
assert.notEqual(global(second, 'answer'), answer);
assert.equal(global(second, 'counter').value, 7);

console.log('table-global: pass');
