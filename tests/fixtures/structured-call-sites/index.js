import assert from 'node:assert/strict';
import { capture } from './helper.cjs';

function caller() { return capture(); }
const sites = caller();
assert.ok(Array.isArray(sites));
const site = sites[0];
assert.equal(site.getFunctionName(), 'caller');
assert.equal(site.getFileName(), '/index.js');
assert.equal(site.getLineNumber(), 4);
assert.ok(site.getColumnNumber() > 0);
assert.equal(site.isEval(), false);
assert.equal(site.isNative(), false);
assert.equal(site.isConstructor(), false);
assert.equal(site.getEvalOrigin(), undefined);
assert.equal(site.getThis(), undefined);
assert.equal(site.getTypeName(), null);
assert.equal(site.getMethodName(), null);
assert.ok(site.toString().includes('/index.js:4:'));
console.log('structured caller');

const previous = Error.prepareStackTrace;
try {
  const target = { message: 'kept' };
  Error.prepareStackTrace = (error, frames) => ({ error, frames });
  Error.captureStackTrace(target);
  assert.equal(target.stack.error, target);
  assert.ok(Array.isArray(target.stack.frames));
  assert.equal(target.message, 'kept');
  assert.equal(Object.getOwnPropertyDescriptor(target, 'stack').enumerable, false);
  console.log('custom result');
} finally {
  Error.prepareStackTrace = previous;
}
assert.equal(typeof new Error('default').stack, 'string');
console.log('formatter restored');
