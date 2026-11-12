// Which group each kind of start joins, as the page's owner records it for each tagged member.
import { strict as assert } from 'node:assert';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { groupOf, memberTag, ownMember } from './page-control.ts';

const child = `${import.meta.dir}/membership-child.ts`;
const root = groupOf(ownMember());
let serial = 0;
const fresh = (kind: string) => `membership-${kind}-${serial++}`;

async function workerRow(options: object, check: () => void = () => {}) {
  const tag = fresh('worker');
  const worker = new Worker(child, { ...options, argv: [memberTag(tag)] });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.equal(groupOf(tag), root, tag);
  check();
  worker.postMessage('leave');
  assert.equal(await new Promise(resolve => worker.once('exit', resolve)), 0);
}

async function ordinaryRow(env: Record<string, string | undefined>) {
  const tag = fresh('ordinary');
  const proc = Bun.spawn([process.execPath, 'run', child, memberTag(tag)], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env });
  assert.notEqual(groupOf(tag), root, tag);
  proc.stdin.end();
  await proc.exited;
}

await workerRow({ workerData: { mode: 'plain' } });
await workerRow({ workerData: { mode: 'plain' }, env: {} });
await workerRow({ workerData: { mode: 'plain' }, env: SHARE_ENV });
const nestedWorker = fresh('nested-worker');
await workerRow({ workerData: { mode: 'nested', inner: nestedWorker } }, () => assert.equal(groupOf(nestedWorker), root, nestedWorker));
const workerChild = fresh('worker-child');
await workerRow({ workerData: { mode: 'ordinary', inner: workerChild } }, () => assert.notEqual(groupOf(workerChild), root, workerChild));

await ordinaryRow(process.env);
for (const marker of ['{"input":1,"output":2}', '', 'not json']) {
  await ordinaryRow({ ...process.env, BUNWASM_WORKER_CONTROL: marker });
  await ordinaryRow({ ...process.env, BUNWASM_WORKER_INIT: marker });
}
console.log('shared-wasm-memory membership: pass');
