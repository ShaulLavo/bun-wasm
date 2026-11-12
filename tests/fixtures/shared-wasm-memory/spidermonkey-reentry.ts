import { strict as assert } from 'node:assert';

const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/imported.wasm`).arrayBuffer());
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
let depth = 0;
let deepest = 0;
let recursive = true;
const instance = new WebAssembly.Instance(module, { env: { memory, observe() {
  if (!recursive) return;
  depth++;
  deepest = Math.max(deepest, depth);
  try { callback(); }
  finally { depth--; }
} } });
const callback = instance.exports.callback;
if (typeof callback !== 'function') throw new Error('Missing callback');
assert.throws(() => callback(), RangeError);
recursive = false;
callback();
assert.equal(depth, 0);
assert.ok(deepest > 0);
console.log(JSON.stringify({ deepest, recovered: true }));
