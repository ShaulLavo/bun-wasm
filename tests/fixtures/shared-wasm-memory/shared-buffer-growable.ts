// Group guests refuse a growable SharedArrayBuffer, because members could not share its length.
// Native Bun supports them, so only guest.ts runs this file.
import { strict as assert } from 'node:assert';

function isRefusal(error: unknown) {
  return error instanceof TypeError || error instanceof RangeError;
}

assert.throws(() => new SharedArrayBuffer(8, { maxByteLength: 16 }), isRefusal);
assert.equal(new SharedArrayBuffer(8).byteLength, 8);
console.log('shared-buffer growable: pass');
