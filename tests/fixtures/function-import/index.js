import assert from 'node:assert/strict';
import factory from './nested/factory.cjs';

for (const key of ['load', 'call', 'indirect', 'asyncLoad']) {
  assert.equal((await factory[key]('./value.mjs')).value, 'relative to factory');
  console.log(key);
}
assert.equal((await factory.generator('./value.mjs').next().value).value, 'relative to factory');
console.log('generator');
assert.equal((await factory.asyncGenerator('./value.mjs').next()).value.value, 'relative to factory');
console.log('async generator');
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
console.log('constructor semantics');
