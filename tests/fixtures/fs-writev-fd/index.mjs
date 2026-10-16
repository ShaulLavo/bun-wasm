import fs from 'node:fs';
import assert from 'node:assert/strict';
const fd = fs.openSync('fd-validation.txt', 'w+');
const vectors = [Buffer.from('bad')];
const range = [fd + 0.75, 1.5, -1, 2 ** 31, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity];
const types = [String(fd), true, null, undefined, 1n, {}, Symbol('fd')];
let failed = false;
let callbackRan = false;
function sync(value) { fs.writevSync(value, vectors); }
function callback(value) { fs.writev(value, vectors, () => { callbackRan = true; }); }
function callbackEmpty(value) { fs.writev(value, [], () => { callbackRan = true; }); }
function emptySync(value) { assert.equal(fs.writevSync(value, []), 0); }
function rejected(invoke, value, code) {
  try { assert.throws(invoke.bind(null, value), { code }); }
  catch (error) { failed = true; console.error('FAIL', invoke.name, String(value), code); }
}
for (const [values, code] of [[range, 'ERR_OUT_OF_RANGE'], [types, 'ERR_INVALID_ARG_TYPE']]) {
  for (const value of values) {
    rejected(sync, value, code);
    rejected(callback, value, code);
    rejected(callbackEmpty, value, code);
    try { emptySync(value); }
    catch (error) { failed = true; console.error('FAIL empty sync', String(value)); }
  }
}
await new Promise(resolve => setImmediate(resolve));
if (callbackRan || fs.fstatSync(fd).size !== 0) { failed = true; console.error('invalid descriptor produced a callback or wrote bytes'); }
fs.closeSync(fd);
if (failed) throw new Error('descriptor validation failed');
console.log('noninteger and invalid descriptors rejected without writes');
