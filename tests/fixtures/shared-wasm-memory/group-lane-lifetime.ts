// Group lane lifetime on real worker_threads members: killed senders, killed owners, ports that
// are never restored, a killed root and worker churn. After each case the ledger must be back at
// its fixed baseline once the host has released every stopped worker: no lane, segment, cell,
// claim or dead end left, the reuse pool within 1 MiB, and every pin it keeps named by a slot.
//
// GROUP_LANE_REFERENCE=1 runs only what native Bun can show: it has no ledger to count, and
// killing its process kills its threads, so the killed-root case cannot run there.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MessageChannel, receiveMessageOnPort, Worker, type WorkerOptions } from 'node:worker_threads';

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

function start(data: object, transferList: NonNullable<WorkerOptions['transferList']> = []) {
  const worker = new Worker(child, { workerData: data, transferList });
  const exited = new Promise<number>(resolve => worker.once('exit', resolve));
  const next = <T>() => new Promise<T>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  return { worker, exited, next };
}
async function opened(gate: Int32Array, index: number) {
  while (Atomics.load(gate, index) === 0) await Bun.sleep(1);
}
function text(bytes: number, seed: number) {
  return String.fromCharCode(97 + seed % 26).repeat(bytes);
}
function settledCensus(census: Census) {
  return census.awaiting === 0 && census.deadEnds === 0 && census.busy === 0 && census.inFlight === 0
    && census.cells === 0 && census.pooledBytes <= POOL_LIMIT;
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
  assert.equal(census.pins, 1 + census.liveLanes + census.pooled, `${label}: every pin is the ledger's, a live lane's or a pooled slot's`);
}

/** The sender is killed after it confirmed the post: its message is still whole. */
async function killedSender() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const sender = start({ mode: 'post-then-block', gate: gate.buffer, port: port2, size: 300_000, seed: 7 }, [port2]);
  await opened(gate, 0);
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
  const sent = new Int32Array(new SharedArrayBuffer(16)), held = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const writer = start({ mode: 'post-then-block', gate: sent.buffer, port: port1, count: 12, size: 150_000, seed: 1 }, [port1]);
  const reader = start({ mode: 'hold-unread', gate: held.buffer, port: port2 }, [port2]);
  await Promise.all([opened(sent, 0), opened(held, 0)]);
  await Promise.all([writer.worker.terminate(), reader.worker.terminate()]);
  await baseline('both owners killed');
}

/** A port carried in a frame its receiver never reads closes when that receiver dies. */
async function unrestoredCarriedPort() {
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const { port1, port2 } = new MessageChannel();
  const carried = new MessageChannel();
  const receiver = start({ mode: 'hold-unread', gate: gate.buffer, port: port2 }, [port2]);
  await opened(gate, 0);
  port1.postMessage({ port: carried.port2, task: text(200_000, 3) }, [carried.port2]);
  const closed = new Promise<void>(resolve => carried.port1.once('close', resolve));
  await receiver.worker.terminate();
  await closed;
  port1.close();
  await baseline('unrestored carried port');
}

/** 200 workers in turn each post one spilled message to their parent; half are killed after it. */
async function churn() {
  for (let index = 0; index < 200; index++) {
    const killed = index % 2 === 1;
    const gate = new Int32Array(new SharedArrayBuffer(16));
    const worker = start({ mode: killed ? 'parent-post-then-block' : 'parent-post-then-exit', gate: gate.buffer, size: 120_000, seed: index });
    const message = await worker.next<{ task: string }>();
    assert.equal(message.task, text(120_000, index), `worker ${index}`);
    if (killed) {
      await opened(gate, 0);
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
  await wait(`${directory}/started`);
  root.kill(9);
  await root.exited;
  await Promise.all([wait(`${directory}/done-0`), wait(`${directory}/done-1`)]);
  assert.equal(readFileSync(`${directory}/done-0`, 'utf8'), '39', 'the first worker read every reply');
  assert.equal(readFileSync(`${directory}/done-1`, 'utf8'), '40', 'the second worker read every message');
  rmSync(directory, { recursive: true });
}

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
