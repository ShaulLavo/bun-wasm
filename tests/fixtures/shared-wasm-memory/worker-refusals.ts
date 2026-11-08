// Group-guest transport refuses what it cannot share, before any worker exists. Native Bun
// clones these, so only guest.ts runs this file.
import { strict as assert } from 'node:assert';
import { Worker } from 'node:worker_threads';
import { oversizedModule } from './oversize-module.ts';

const unshared = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/unshared.wasm`).arrayBuffer());
function refused(workerData: object, reason: RegExp) {
  assert.throws(() => new Worker(`${import.meta.dir}/cross-worker-child.ts`, { workerData }), (error: Error) => {
    assert.equal(error.name, 'DataCloneError');
    assert.match(error.message, reason);
    return true;
  });
}
refused({ mode: 'identity', buffer: new SharedArrayBuffer(4) }, /Only WebAssembly shared memory buffers/);
refused({ mode: 'identity', memory: new WebAssembly.Memory({ initial: 1 }) }, /Only shared WebAssembly memories/);
refused({ mode: 'identity', module: unshared }, /Only WebAssembly modules with a shared memory/);
refused({ mode: 'identity', module: oversizedModule() }, /nested request limit/);
console.log('shared-wasm-memory worker refusals: pass');
