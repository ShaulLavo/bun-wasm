import { strict as assert } from 'node:assert';
import { Worker, MessageChannel } from 'node:worker_threads';

const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: true });
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/cross-worker.wasm`).arrayBuffer());
function refused(operation: () => void) {
  assert.throws(operation, (error: Error) => {
    assert.equal(error.name, 'DataCloneError');
    assert.match(error.message, /Same-region worker transport is not available on the Browser host/);
    return true;
  });
}
for (const value of [memory, module]) {
  refused(() => { new Worker(`${import.meta.dir}/cross-worker-child.ts`, { workerData: { value } }); });
  const { port1, port2 } = new MessageChannel();
  try { refused(() => port1.postMessage({ value })); }
  finally { port1.close(); port2.close(); }
}
console.log('shared-wasm-memory Browser worker refusals: pass');
