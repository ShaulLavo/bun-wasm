import { readFileSync } from 'node:fs';
const module = new WebAssembly.Module(readFileSync('./module.wasm'));
let one = () => 0, wide = () => 1n, pair = () => [1, 2];
const e = new WebAssembly.Instance(module, { env: {
  one: () => one(), wide: () => wide(), pair: () => pair(),
} }).exports;
let failures = 0;
function assert(value, label) { if (!value) throw new Error(label); }
function same(actual, expected) { assert(Object.is(actual, expected), `${actual} != ${expected}`); }
function throws(action, type) {
  try { action(); } catch (error) { assert(error instanceof type, `expected ${type.name}, got ${error}`); return; }
  throw new Error(`expected ${type.name}`);
}
function check(label, action) {
  try { action(); console.log('PASS', label); }
  catch (error) { failures++; console.log('FAIL', label, error.message); }
}
check('memory aliases', () => {
  same(e.first, e.second);
  new Uint8Array(e.first.buffer)[0] = 42;
  same(e.load(), 42);
  same(new Uint8Array(e.second.buffer)[0], 42);
  assert(e.empty !== e.otherEmpty, 'distinct empty memories');
});
function grows(action, expected) {
  const old = e.first.buffer, empty = e.empty.buffer;
  same(action(), expected);
  same(old.byteLength, 0);
  assert(old !== e.first.buffer, 'new buffer');
  same(e.empty.buffer, empty);
}
check('JS zero growth', () => grows(() => e.first.grow(0), 1));
check('wasm constant zero growth', () => grows(() => e.zero(), 1));
check('wasm dynamic zero growth', () => grows(() => e.grow(0), 1));
check('positive and failed growth', () => {
  grows(() => e.first.grow(1), 1);
  same(e.first.buffer.byteLength, 131072);
  const old = e.first.buffer;
  throws(() => e.first.grow(2), RangeError);
  same(e.grow(2), -1);
  same(e.first.buffer, old);
});
check('i32 coercion', () => {
  for (const value of [Infinity, -Infinity, NaN, 2 ** 64, -(2 ** 64), undefined]) same(e.i32(value), 0);
  for (const value of [2 ** 32 + 3, -(2 ** 32) + 3, 3.9, '3', true, null]) same(e.i32(value), value >> 0);
  throws(() => e.i32(1n), TypeError);
  throws(() => e.i32(Symbol()), TypeError);
});
check('i64 coercion', () => {
  for (const value of [1, undefined, null, Symbol()]) throws(() => e.i64(value), TypeError);
  for (const value of [1n, -1n, 2n ** 80n + 5n, true, '17', { valueOf: () => 9n }]) same(e.i64(value), BigInt.asIntN(64, value));
});
check('float coercion', () => {
  same(e.f64(), NaN); same(e.f32(), NaN);
  same(e.f64('2.5'), 2.5); same(e.f32(1 / 3), Math.fround(1 / 3));
  same(e.f64(Infinity), Infinity); same(e.f64(-0), -0);
  throws(() => e.f32(1n), TypeError); throws(() => e.f64(Symbol()), TypeError);
});
check('grow validation', () => {
  for (const value of [-1, -1.9, Infinity, -Infinity, NaN, undefined, 2 ** 32, 1n, Symbol()]) throws(() => e.first.grow(value), TypeError);
  grows(() => e.first.grow(0.9), 2);
  grows(() => e.first.grow('0'), 2);
  throws(() => e.first.grow(2 ** 32 - 1), RangeError);
});
check('coercion exception identity', () => {
  const sentinel = { marker: 'conversion' };
  const value = { valueOf() { throw sentinel; } };
  for (const action of [() => e.i32(value), () => e.i64(value), () => e.f64(value), () => e.first.grow(value), () => { e.counter.value = value; }]) {
    let caught = false;
    try { action(); } catch (error) { same(error, sentinel); caught = true; }
    assert(caught, 'must throw sentinel');
  }
  throws(() => e.trap(), WebAssembly.RuntimeError);
});
check('global coercion', () => {
  e.counter.value = Infinity; same(e.counter.value, 0);
  e.counter.value = 2 ** 32 + 3; same(e.counter.value, 3);
  throws(() => { e.counter.value = 1n; }, TypeError);
  e.big.value = '17'; same(e.big.value, 17n);
  throws(() => { e.big.value = 1; }, TypeError);
  throws(() => { e.fixed.value = 4; }, TypeError);
});
check('import result coercion and recovery', () => {
  one = () => Infinity; same(e.one(), 0);
  one = () => undefined; same(e.one(), 0);
  wide = () => 1; throws(() => e.wide(), TypeError);
  wide = () => '19'; same(e.wide(), 19n);
  pair = () => new Set(['3', '2.5']); same(e.pair().join(','), '3,2.5');
  pair = () => [1]; throws(() => e.pair(), TypeError);
  pair = () => 1; throws(() => e.pair(), TypeError);
  const sentinel = new Error('coercion');
  one = () => ({ valueOf() { throw sentinel; } });
  try { e.one(); throw new Error('missing throw'); } catch (error) { same(error, sentinel); }
  for (const value of [undefined, null, false, 0, '']) {
    one = () => { throw value; };
    let caught = false;
    try { e.one(); } catch (error) { same(error, value); caught = true; }
    assert(caught, 'falsy exception');
  }
  one = () => 23; same(e.one(), 23);
});
if (failures) throw new Error(`${failures} contract failures`);
