// Group lane lifetime on real worker_threads members: killed senders, killed owners, ports that
// are never restored, a killed root and worker churn. After each case the ledger must be back at
// its fixed baseline once the host has released every stopped worker: no lane, segment, cell,
// claim or dead end left and the reuse pool within 1 MiB.
//
// The census is the ledger's own count, so it cannot see a host pin the ledger never named. On
// the Browser host the page also answers with the group owner's real counters (page-control.ts):
// its pins beyond this guest's start must be exactly the pins the ledger names. Native has no
// per-case owner sample; its group end asserts zero regions and pins (shm.rs).
//
// GROUP_LANE_REFERENCE=1 runs only what native Bun can show: it has no ledger to count, and
// killing its process kills its threads, so the killed-root case cannot run there.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MessageChannel, receiveMessageOnPort, Worker, type WorkerOptions } from 'node:worker_threads';
import { ownerSnapshot, type OwnerSnapshot } from './page-control.ts';

type Census = {
  liveLanes: number; openEnds: number; inFlight: number; deadEnds: number; linkedSegments: number;
  cells: number; busy: number; pooled: number; pooledBytes: number; pins: number; awaiting: number;
};
const reference = process.env.GROUP_LANE_REFERENCE === '1';
// The census is a read-only internal module behind Bun's own testing flag.
if (!reference) process.env.BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING = '1';
const lanes = reference ? null : createRequire(import.meta.url)('internal/bunwasm/group-lanes') as { census(): Census | null };
const child = `${import.meta.dir}/group-lane-child.ts`;
const POOL_LIMIT = 1 << 20;
const DEADLINE_MS = 60_000;
/** Owner regions per SharedArrayBuffer this guest made (a data region and its page cell). */
const REGIONS_PER_SHARED_BUFFER = 2;
/** Runtime regions besides lanes and fixture buffers, such as a page-cell arena. */
const REGION_SLACK = 4;
const TAG = '--shared-wasm-member=';
const member = process.argv.find(value => value.startsWith(TAG))?.slice(TAG.length);
const running = new Set<Worker>();
let sharedBuffers = 0;

function gate() {
  sharedBuffers++;
  return new Int32Array(new SharedArrayBuffer(16));
}
function start(data: object, transferList: NonNullable<WorkerOptions['transferList']> = []) {
  const worker = new Worker(child, { workerData: data, transferList });
  running.add(worker);
  const exited = new Promise<number>(resolve => worker.once('exit', code => { running.delete(worker); resolve(code); }));
  const next = <T>() => new Promise<T>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  return { worker, exited, next };
}
async function opened(word: Int32Array, index: number) {
  while (Atomics.load(word, index) === 0) await Bun.sleep(1);
}
function text(bytes: number, seed: number) {
  return String.fromCharCode(97 + seed % 26).repeat(bytes);
}
function settledCensus(census: Census) {
  return census.awaiting === 0 && census.deadEnds === 0 && census.busy === 0 && census.inFlight === 0
    && census.cells === 0 && census.pooledBytes <= POOL_LIMIT;
}
function owner(): OwnerSnapshot | undefined {
  return member === undefined ? undefined : ownerSnapshot(member);
}
// Before any worker: no ledger, no tag and no lane exist yet.
const ownerStart = reference ? undefined : owner();

/** Compares the real owner, sampled after the ledger settled, with what the ledger names. */
function ownerAgrees(label: string, census: Census) {
  if (!ownerStart) return;
  const now = owner()!;
  assert.equal(now.pins - ownerStart.pins, census.pins, `${label}: owner pins beyond the start are exactly the ledger's named pins`);
  // Each named pin keeps one region alive, and this guest holds one tag region.
  const named = census.pins + 1;
  assert.ok(now.regions >= named, `${label}: the owner holds every region the ledger names`);
  const allowed = REGIONS_PER_SHARED_BUFFER * sharedBuffers + REGION_SLACK;
  const surplus = now.regions - ownerStart.regions - named;
  assert.ok(surplus <= allowed, `${label}: ${surplus} owner regions beyond the lanes, at most ${allowed} for live shared buffers`);
}

/**
 * Turns the event loop, whose steps sweep, until the host has released every stopped worker,
 * then checks the baseline. `liveLanes` counts the lanes the case leaves open on purpose.
 */
async function baseline(label: string, liveLanes = 0) {
  if (!lanes) return;
  const deadline = Date.now() + DEADLINE_MS;
  let census = lanes.census();
  assert.ok(census, `${label}: this guest has a ledger`);
  while (!settledCensus(census)) {
    if (Date.now() > deadline) throw new Error(`${label}: the ledger never settled: ${JSON.stringify(census)}`);
    await Bun.sleep(5);
    census = lanes.census()!;
  }
  assert.equal(census.liveLanes, liveLanes, `${label}: lanes left open`);
  assert.equal(census.linkedSegments, 0, `${label}: spill segments left linked`);
  assert.equal(census.pins, 1 + census.liveLanes + census.pooled, `${label}: the ledger names only its own, live and pooled pins`);
  ownerAgrees(label, census);
}

/** The sender is killed after it confirmed the post: its message is still whole. */
async function killedSender() {
  const sent = gate();
  const { port1, port2 } = new MessageChannel();
  const sender = start({ mode: 'post-then-block', gate: sent.buffer, port: port2, size: 300_000, seed: 7 }, [port2]);
  await opened(sent, 0);
  await sender.worker.terminate();
  const received = receiveMessageOnPort(port1);
  assert.ok(received, 'a killed sender\'s confirmed message is readable');
  assert.equal((received.message as { task: string }).task, text(300_000, 7));
  assert.equal(receiveMessageOnPort(port1), undefined);
  port1.close();
  await baseline('killed sender');
}

/** Both owners of a lane are killed with spilled messages unread between them. */
async function bothOwnersKilled() {
  const sent = gate(), held = gate();
  const { port1, port2 } = new MessageChannel();
  const writer = start({ mode: 'post-then-block', gate: sent.buffer, port: port1, count: 12, size: 150_000, seed: 1 }, [port1]);
  const reader = start({ mode: 'hold-unread', gate: held.buffer, port: port2 }, [port2]);
  await Promise.all([opened(sent, 0), opened(held, 0)]);
  await Promise.all([writer.worker.terminate(), reader.worker.terminate()]);
  await baseline('both owners killed');
}

/** A port carried in a frame its receiver never reads closes when that receiver dies. */
async function unrestoredCarriedPort() {
  const held = gate();
  const { port1, port2 } = new MessageChannel();
  const carried = new MessageChannel();
  const receiver = start({ mode: 'hold-unread', gate: held.buffer, port: port2 }, [port2]);
  await opened(held, 0);
  port1.postMessage({ port: carried.port2, task: text(200_000, 3) }, [carried.port2]);
  const closed = new Promise<void>(resolve => carried.port1.once('close', resolve));
  await receiver.worker.terminate();
  await closed;
  port1.close();
  await baseline('unrestored carried port');
}

/** 200 workers in turn each post one spilled message to their parent; half are killed after it. */
async function churn() {
  // One gate for every worker, so churn adds no shared buffers of its own.
  const sent = gate();
  for (let index = 0; index < 200; index++) {
    const killed = index % 2 === 1;
    Atomics.store(sent, 0, 0);
    const worker = start({ mode: killed ? 'parent-post-then-block' : 'parent-post-then-exit', gate: sent.buffer, size: 120_000, seed: index });
    const message = await worker.next<{ task: string }>();
    assert.equal(message.task, text(120_000, index), `worker ${index}`);
    if (killed) {
      await opened(sent, 0);
      await worker.worker.terminate();
    }
    await worker.exited;
  }
  await baseline('churn');
}

/** The group's first guest is killed by pid while two of its workers exchange spilled messages. */
async function killedRoot() {
  const directory = mkdtempSync('group-lane-root-');
  const root = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/group-lane-root.ts`, directory], { stdout: 'inherit', stderr: 'inherit' });
  const deadline = Date.now() + DEADLINE_MS;
  const wait = async (path: string) => {
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`killed root: ${path} never appeared`);
      await Bun.sleep(5);
    }
  };
  try {
    await wait(`${directory}/started`);
    root.kill(9);
    await root.exited;
    await Promise.all([wait(`${directory}/done-0`), wait(`${directory}/done-1`)]);
    assert.equal(readFileSync(`${directory}/done-0`, 'utf8'), '39', 'the first worker read every reply');
    assert.equal(readFileSync(`${directory}/done-1`, 'utf8'), '40', 'the second worker read every message');
  } finally {
    // Its workers bound their own waits (group-lane-child.ts) and exit if the exchange stalls.
    if (root.exitCode === null && root.signalCode === null) root.kill(9);
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  await killedSender();
  await bothOwnersKilled();
  await unrestoredCarriedPort();
  await churn();
  if (reference) {
    console.log('shared-wasm-memory group lane lifetime: reference only (no ledger census, no killed root)');
  } else {
    await killedRoot();
    console.log('shared-wasm-memory group lane lifetime: pass');
  }
} finally {
  // A failed case must not leave its blocked workers behind.
  await Promise.all(Array.from(running, worker => worker.terminate()));
}
