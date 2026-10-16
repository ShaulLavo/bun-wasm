import assert from 'node:assert/strict';
import factory from './nested/factory.cjs';
import { load as esmLoad } from './nested/factory.mjs';

for (const key of ['load', 'call', 'indirect', 'asyncLoad', 'asi']) {
  assert.equal((await factory[key]('./value.mjs')).value, 'relative to factory');
  console.log(key);
}
assert.equal((await factory.generator('./value.mjs').next().value).value, 'relative to factory');
console.log('generator');
assert.equal((await factory.parameter()).value, 'relative to factory');
console.log('parameter default');
assert.equal((await factory.object.import('./value.mjs')).value, 'relative to factory');
console.log('method import');
assert.equal((await factory.asyncGenerator('./value.mjs').next()).value.value, 'relative to factory');
console.log('async generator');
assert.equal((await esmLoad('./value.mjs')).value, 'relative to factory');
console.log('esm factory');
const previousPrepare = Error.prepareStackTrace;
let customLoad;
try {
  Error.prepareStackTrace = () => 'custom stack';
  customLoad = factory.make();
  assert.equal(Error.prepareStackTrace(), 'custom stack');
} finally {
  Error.prepareStackTrace = previousPrepare;
}
assert.equal((await customLoad('./value.mjs')).value, 'relative to factory');
console.log('custom formatter');
class Derived extends Function {}
const derived = new Derived('specifier', 'return import(specifier)');
assert.ok(derived instanceof Derived);
assert.equal((await derived('./nested/value.mjs')).value, 'relative to factory');
assert.equal(Function.prototype.constructor, Function);
assert.equal(new Function('x', 'return x + 1').name, 'anonymous');
assert.equal(new Function('x', 'return x + 1')(2), 3);
const order = [];
const parameter = { toString() { order.push('parameter'); return 'x'; } };
const body = { toString() { order.push('body'); return 'return x'; } };
assert.equal(new Function(parameter, body)(4), 4);
assert.deepEqual(order, ['parameter', 'body']);
assert.throws(() => Function(Symbol()), TypeError);
assert.throws(() => Function('return import('), SyntaxError);
assert.throws(() => Function('return new import("node:fs")'), SyntaxError);
assert.equal(new Function('return { import(value) { return value; } }')().import(7), 7);
assert.equal(new Function('return class { import(value) { return value; } }')().prototype.import(8), 8);
assert.equal(new Function('return { import(value = /[()]/) { return value.source; } }')().import(), '[()]');
console.log('constructor semantics');
