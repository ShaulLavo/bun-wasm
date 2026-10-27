declare function fixture(name: string): WebAssembly.Module;
declare function check(condition: unknown, message: string): void;
function equal(actual: unknown, expected: unknown, label: string) { check(Object.is(actual, expected), label); }
function throws(action: () => unknown, name: string) {
  try { action(); }
  catch (error) {
    check(error && typeof error === 'object' && 'name' in error && error.name === name, 'expected ' + name);
    return;
  }
  throw new Error('expected ' + name);
}
function callable(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') throw new Error('Expected callable');
  return (...args) => value(...args);
}
function table(instance: WebAssembly.Instance, name = 'table') {
  const value = instance.exports[name];
  if (!(value instanceof WebAssembly.Table)) throw new Error('Expected table');
  return value;
}
function memory(instance: WebAssembly.Instance) {
  const value = instance.exports.memory;
  if (!(value instanceof WebAssembly.Memory)) throw new Error('Expected memory');
  return value;
}
function call(instance: WebAssembly.Instance, name: string, ...args: unknown[]) { return callable(instance.exports[name])(...args); }
const provider = new WebAssembly.Instance(fixture('table'), { env: { callback: (value: number) => value + 10 } });
const entries = table(provider);
equal(entries, provider.exports.alias, 'real table alias');
equal(entries.get(0), provider.exports.inc, 'real callable alias');
equal(call(provider, 'call', 4, 1), 14, 'callback');
equal(entries.grow(1), 2, 'growth previous length');
equal(entries.get(2), null, 'funcref default');
entries.set(2, entries.get(0));
equal(call(provider, 'call', 8, 2), 9, 'indirect mutation');
throws(() => entries.get(3), 'RangeError');
throws(() => entries.set(3, null), 'RangeError');
throws(() => entries.set(2, () => 9), 'TypeError');
throws(() => entries.grow(2), 'RangeError');
const consumer = new WebAssembly.Instance(fixture('import-table'), { env: { table: entries, callback: (value: number) => value + 100 } });
equal(consumer.exports.table, entries, 'imported identity');
equal(call(consumer, 'call', 4, 1), 14, 'callback owner');
entries.set(2, null);
throws(() => call(consumer, 'call', 1, 2), 'RuntimeError');
const refs = new WebAssembly.Instance(fixture('externref'));
const references = table(refs, 'references');
const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
for (const value of [undefined, null, true, false, 42, -0, NaN, 'text', 42n, Symbol('reference'), () => 42, { value: 42 }, cyclic]) {
  references.set(0, value);
  equal(references.get(0), value, 'arbitrary JS identity');
  equal(call(refs, 'echo', value), value, 'externref call identity');
}
equal(references.grow(1, undefined), 2, 'externref growth');
equal(references.get(2), undefined, 'undefined distinct from null');
console.log('PASS real native table aliases/imports/callables/owner/externrefs');

const standalone = new WebAssembly.Table({ element: 'externref', initial: 1, maximum: 3 });
equal(standalone.get(0), undefined, 'standalone externref default');
const nullFunctions = new WebAssembly.Table({ element: 'anyfunc', initial: 2, maximum: 4 });
equal(nullFunctions.get(0), null, 'standalone funcref default');
throws(() => new WebAssembly.Instance(fixture('import-table'), { env: { table: standalone, callback() {} } }), 'LinkError');
const reused = new WebAssembly.Instance(fixture('reuse'), { env: { function: provider.exports.inc } });
equal(reused.exports.function, provider.exports.inc, 'reused Wasm callable identity');
equal(call(reused, 'function', 10), 11, 'reused Wasm callable');
const identity = (value: unknown) => value;
const signatures = new WebAssembly.Instance(fixture('signatures'), { env: { callback: identity } });
equal(call(signatures, 'integer', 42), 42, 'same JS callback integer signature');
const marker = { identity: true };
equal(call(signatures, 'reference', marker), marker, 'same JS callback externref signature');
throws(() => new WebAssembly.Instance(fixture('reuse'), { env: { function: signatures.exports.reference } }), 'LinkError');
let reenter: (value: number) => number;
const owner = new WebAssembly.Instance(fixture('memory-owner'), { env: { callback(value: number) {
  equal(new Uint8Array(memory(owner).buffer)[0], value, 'callback sees cross-instance write');
  return reenter(value) + 1000;
} } });
reenter = value => { equal(call(owner, 'read'), value, 'reentrant Wasm call'); return value; };
const cross = new WebAssembly.Instance(fixture('import-table'), { env: { table: table(owner), callback: () => -1 } });
equal(call(cross, 'call', 7, 0), 1007, 'cross-instance callback owner and reentry');
table(owner).set(0, owner.exports.grow);
const oldBuffer = memory(owner).buffer;
equal(call(cross, 'call', 1, 0), 1, 'indirect cross-instance grow');
equal(oldBuffer.byteLength, 0, 'cross-instance grow detaches');
equal(memory(owner).buffer.byteLength, 131072, 'cross-instance memory refresh');
let fail = true;
const thrown = new WebAssembly.Instance(fixture('table'), { env: { callback(value: number) {
  if (fail) throw marker;
  return value + 5;
} } });
try { call(thrown, 'call', 2, 1); throw new Error('missing callback exception'); }
catch (error) { equal(error, marker, 'callback exception identity'); }
fail = false;
equal(call(thrown, 'call', 2, 1), 7, 'completion after thrown callback');
console.log('PASS standalone tables/signatures/reused imports/reentry/throw/cross-instance memory grow');

const numeric = new WebAssembly.Instance(fixture('numeric'));
equal(call(numeric, 'integer', { valueOf: () => 42 }), 42, 'numeric object coercion');
equal(call(numeric, 'wide', Object(42n)), 42n, 'i64 object coercion');
throws(() => call(numeric, 'integer', 42n), 'TypeError');
throws(() => call(numeric, 'float', Object(42n)), 'TypeError');
throws(() => call(numeric, 'wide', 42), 'TypeError');
for (const value of [-0, NaN, Infinity, -Infinity]) equal(call(numeric, 'float', value), value, 'numeric special values');
console.log('PASS numeric conversion preserves existing WebAssembly coercion');
