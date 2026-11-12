// A member whose native terminate fails stays owner debt: its publication and memory outlive this
// run, and the page asserts that once the root has gone. No group of this page may end cleanly.
import { strict as assert } from 'node:assert';
import { Worker } from 'node:worker_threads';
import { memberTag, stopFailed } from './page-control.ts';

const tag = 'fail-stop-worker';
const worker = new Worker(`${import.meta.dir}/failed-stop-child.ts`, { argv: [memberTag(tag)] });
const memory = await new Promise<WebAssembly.Memory>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
const view = new Int32Array(memory.buffer);
assert.equal(Atomics.load(view, 0), 71);
assert.equal(await worker.terminate(), 1);
stopFailed(tag);
Atomics.store(view, 1, 72);
assert.equal(Atomics.load(view, 1), 72, 'retained memory stays usable by the survivor');
console.log('shared-wasm-memory failed stop: pass');
