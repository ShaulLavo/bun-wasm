// Engine-owned behavior of region-backed buffers that every embedded engine must keep:
// views stay live through collection and growth, and JS waits use the group provider.
import assert from 'node:assert/strict';

const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
const first = memory.buffer;
const view = new Int32Array(first);
Atomics.store(view, 0, 11);
assert.equal(Atomics.wait(view, 0, 1, 0), 'not-equal');
assert.equal(Atomics.wait(view, 0, 11, 0), 'timed-out');
assert.equal(Atomics.notify(view, 0, 2), 0);

const prefixes: SharedArrayBuffer[] = [first];
for (let page = 1; page < 4; page++) {
  assert.equal(memory.grow(1), page);
  prefixes.push(memory.buffer);
  gc();
}
for (const [index, buffer] of prefixes.entries()) {
  assert.equal(buffer.byteLength, (index + 1) * 65536);
  assert.equal(Atomics.load(new Int32Array(buffer), 0), 11);
}
Atomics.store(new Int32Array(prefixes[3]!), 0, 22);
assert.equal(Atomics.load(view, 0), 22);

// A collection deep in the native stack must still see every frame's held values.
function deep(depth: number): number {
  const held = { depth };
  if (depth === 0) {
    gc();
    return 0;
  }
  const below = deep(depth - 1);
  assert.equal(held.depth, depth);
  return below + 1;
}
assert.equal(deep(200), 200);

function gc() {
  (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun?.gc(true);
}

console.log('shared-wasm-memory engine roots: pass');
