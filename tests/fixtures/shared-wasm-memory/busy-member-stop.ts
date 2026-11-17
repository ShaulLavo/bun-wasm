// A terminated group member that is busy in JavaScript must really stop, and its pages must come
// back to the group once that stop is proven. Real iOS Safari keeps running a terminated worker
// that is busy in Wasm, so the member's own engine poll of runtime_proc.signal(0, 4) is what ends
// it: Waffle selects SIGKILL before Worker.terminate(). Waffle keeps a released member's pages in
// quarantine until the member's per-incarnation exit lock is granted, then returns them.
//
// Browser host only: it needs the page's agent lock observer and the group owner's counters.
import { strict as assert } from 'node:assert';
import { Worker } from 'node:worker_threads';
import { agentArmed, agentClosed, memberTag, ownerReleased, ownerSnapshot, type OwnerSnapshot } from './page-control.ts';

const DEADLINE_MS = 30_000;
const tag = 'busy-member-stop';
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function snapshot(): OwnerSnapshot {
  const value = ownerSnapshot(tag);
  assert.ok(value, 'the page answers for the busy member group');
  return value;
}
function drained(value: OwnerSnapshot): boolean { return value.exiting === 0 && value.quarantinedBytes === 0; }

const ready = new Int32Array(new SharedArrayBuffer(4));
const worker = new Worker(`${import.meta.dir}/busy-member-child.ts`, { workerData: { ready }, argv: [memberTag(tag)] });
const exited = new Promise<number>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
if (Atomics.wait(ready, 0, 0, DEADLINE_MS) === 'timed-out') throw new Error('The busy member never started spinning');
agentArmed(tag);
const before = snapshot();

assert.equal(await worker.terminate(), 1);
assert.equal(await exited, 1);
ownerReleased(tag);
// The member's agent ended: its loop stopped, rather than spinning on after terminate().
agentClosed(tag);

const deadline = Date.now() + DEADLINE_MS;
let after = snapshot();
while (!drained(after)) {
  if (Date.now() > deadline) throw new Error(`The stopped member's pages never came back: ${JSON.stringify(after)}`);
  Atomics.wait(sleeper, 0, 0, 5);
  after = snapshot();
}
assert.equal(after.members, before.members - 1, 'the stopped member left the group');
assert.equal(after.exiting, 0, 'no stopped member is still waiting for its exit proof');
assert.equal(after.quarantinedBytes, 0, "the stopped member's pages left quarantine");
console.log('shared-wasm-memory busy member stop: pass');
