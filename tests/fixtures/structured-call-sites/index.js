import assert from 'node:assert/strict';
import { capture } from './helper.cjs';

function caller() { const sites = capture(); return sites; }
const sites = caller();
assert.ok(Array.isArray(sites));
const site = sites[0];
assert.equal(site.getFunctionName(), 'caller');
assert.ok(site.getFileName().endsWith('index.js'));
assert.ok(site.getLineNumber() > 0);
assert.ok(site.getColumnNumber() > 0);
assert.equal(site.isEval(), false);
assert.equal(site.isNative(), false);
assert.equal(site.isConstructor(), false);
assert.equal(site.getEvalOrigin(), undefined);
assert.equal(site.getThis(), undefined);
assert.equal(site.getTypeName(), null);
assert.equal(site.getMethodName(), null);
assert.ok(/index\.js:\d+:/.test(site.toString()));
console.log('structured caller');

const previous = Error.prepareStackTrace;
try {
  const target = { message: 'kept' };
  Error.prepareStackTrace = function (error, frames) {
    assert.equal(this, Error);
    return { error, frames };
  };
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

const generatedSites = Function('capture', 'return capture()')(capture);
for (const frame of generatedSites) {
  if (!frame.isEval()) continue;
  const origin = frame.getEvalOrigin();
  assert.notEqual(origin, '<input>');
  assert.notEqual(origin, '<eval>');
}
console.log('eval origin metadata');
