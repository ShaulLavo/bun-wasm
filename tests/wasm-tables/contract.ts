function equal(actual: unknown, expected: unknown, label: string) { check(Object.is(actual, expected), label); }
function throws(action: () => unknown, name: string) {
  try { action(); } catch (error) { equal(error.name, name, 'expected ' + name); return; }
  throw new Error('expected ' + name);
}
const provider = new WebAssembly.Instance(fixture('table'), { env: { callback: (value: number) => value + 10 } });
const table = provider.exports.table;
equal(table, provider.exports.alias, 'real table alias');
equal(table.get(0), provider.exports.inc, 'real callable alias');
equal(provider.exports.call(4, 1), 14, 'callback');
equal(table.grow(1), 2, 'growth previous length');
equal(table.get(2), null, 'funcref default');
table.set(2, table.get(0));
equal(provider.exports.call(8, 2), 9, 'indirect mutation');
throws(() => table.get(3), 'RangeError');
throws(() => table.set(3, null), 'RangeError');
throws(() => table.set(2, () => 9), 'TypeError');
throws(() => table.grow(2), 'RangeError');
const consumer = new WebAssembly.Instance(fixture('import-table'), { env: { table, callback: (value: number) => value + 100 } });
equal(consumer.exports.table, table, 'imported identity');
equal(consumer.exports.call(4, 1), 14, 'callback owner');
const refs = new WebAssembly.Instance(fixture('externref'));
for (const value of [undefined, null, true, false, 42, -0, NaN, 'text', 42n, Symbol('reference'), () => 42, { value: 42 }]) {
  refs.exports.references.set(0, value);
  equal(refs.exports.references.get(0), value, 'arbitrary JS identity');
  equal(refs.exports.echo(value), value, 'externref call identity');
}
equal(refs.exports.references.grow(1, undefined), 2, 'externref growth');
equal(refs.exports.references.get(2), undefined, 'undefined distinct from null');
console.log('PASS real native table aliases/imports/callables/owner/externrefs');
