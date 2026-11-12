// Region-backed buffers come back from unreachable cycles when their regions run out, and a live
// typed view keeps its own. Run with BUN_WASM_TRACE=1 to read the owner counters at member stop.
import { strict as assert } from 'node:assert';

const ROUNDS = 6_000; // More than the 4,096 regions a group can hold at once.

type Cycle = { buffer: SharedArrayBuffer; self?: Cycle };

function dropCycle(seed: number) {
  const cycle: Cycle = { buffer: new SharedArrayBuffer(8) };
  cycle.self = cycle;
  new Uint8Array(cycle.buffer)[0] = seed;
}

const live = new Int32Array(new SharedArrayBuffer(8));
Atomics.store(live, 0, 41);

for (let round = 0; round < ROUNDS; round += 1) dropCycle(round & 0xff);

assert.equal(Atomics.add(live, 0, 1), 41);
assert.equal(Atomics.load(live, 0), 42);

const source = new SharedArrayBuffer(16);
new Uint8Array(source)[3] = 9;
for (let round = 0; round < ROUNDS; round += 1) assert.equal(new Uint8Array(source.slice(3, 4))[0], 9);

assert.equal(Atomics.load(live, 0), 42);
console.log('shared-buffer churn: pass');
