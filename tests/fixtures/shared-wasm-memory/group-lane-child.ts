import { renameSync, writeFileSync } from 'node:fs';
import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';

type Data = { mode: string; port: MessagePort; gate: SharedArrayBuffer; check: string; count: number; size: number; seed: number; side: number; directory: string };
const data: Data = workerData;

function publishMarker(path: string, value: string) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, value);
  renameSync(temporary, path);
}

function check(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}
function open(gate: Int32Array, index: number) {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}
function text(bytes: number, seed: number) {
  return String.fromCharCode(97 + seed % 26).repeat(bytes);
}
/** The sender's description: kind, size and seed of what the receiver must see. */
function verify(message: unknown, description: string) {
  const [kind, size, seed] = description.split(':');
  if (kind === 'text') {
    check((message as { task: string }).task === text(Number(size), Number(seed)), `${description}: text`);
    return;
  }
  const view = new Uint8Array((message as { buffer: ArrayBuffer }).buffer);
  check(view.length === Number(size), `${description}: length`);
  for (let index = 0; index < view.length; index += 4099) check(view[index] === ((index * 31 + Number(seed)) & 255), `${description}: byte ${index}`);
}

/** Blocks with no timeout before the post; the first receive after the notify must succeed. */
function blocked() {
  const gate = new Int32Array(data.gate);
  open(gate, 0);
  check(Atomics.wait(gate, 1, 0) !== 'timed-out', 'woken by the notify');
  const received = receiveMessageOnPort(data.port);
  check(received !== undefined, `${data.check}: readable at the first receive`);
  verify(received!.message, data.check);
  parentPort!.postMessage('received');
}

function reply() {
  data.port.postMessage({ task: text(197_589, 4) });
  open(new Int32Array(data.gate), 1);
}

function siblingSender() {
  data.port.postMessage({ task: text(197_589, 6) });
  open(new Int32Array(data.gate), 1);
}

function carried() {
  const gate = new Int32Array(data.gate);
  open(gate, 0);
  check(Atomics.wait(gate, 1, 0) !== 'timed-out', 'woken by the notify');
  const received = receiveMessageOnPort(data.port);
  check(received !== undefined, 'a message carrying a port is readable at the first receive');
  const port = (received!.message as { reply: MessagePort }).reply;
  port.postMessage('through the carried port');
  port.once('message', value => {
    check(value === 'back', 'the carried port receives');
    port.close();
    data.port.close();
  });
}

function backlog() {
  let next = 0;
  data.port.on('close', () => {
    check(next === data.count, `all ${data.count} frames arrived before the close, got ${next}`);
    parentPort!.postMessage(next);
  });
  data.port.on('message', value => {
    check(value === next, `in order: expected ${next}, got ${value}`);
    next++;
  });
  parentPort!.postMessage('ready');
}

function burst() {
  for (let index = 0; index < data.count; index++) data.port.postMessage(index);
  data.port.close();
}

/**
 * Failure bound for the lifetime modes only: a worker its case never kills, or an exchange that
 * stalls, ends with an error instead of outliving the fixture. It never makes a receive succeed.
 */
const STALL_MS = 120_000;
function stalled(word: Int32Array, index: number, value: number) {
  if (Atomics.wait(word, index, value, STALL_MS) === 'timed-out') throw new Error(`${data.mode}: stalled for ${STALL_MS} ms`);
}

/** Posts, confirms the post through the gate, then blocks until it is killed. */
function postThenBlock(port: { postMessage(value: unknown): void }) {
  for (let index = 0; index < (data.count || 1); index++) port.postMessage({ task: text(data.size, data.seed + index) });
  const gate = new Int32Array(data.gate);
  open(gate, 0);
  stalled(gate, 3, 0);
}

/** Never reads: confirms it holds its port, then blocks until it is killed. */
function holdUnread() {
  const gate = new Int32Array(data.gate);
  open(gate, 0);
  stalled(gate, 3, 0);
}

/**
 * One side of a ping-pong in turns counted by a shared word: on its turn a side must read the
 * previous message at the first receive, then post the next. No event-loop turn is needed, so
 * the exchange outlives the guest that set it up.
 */
function pingPong() {
  const turn = new Int32Array(data.gate);
  let received = 0;
  for (let step = data.side; step < data.count; step += 2) {
    for (let now = Atomics.load(turn, 0); now !== step; now = Atomics.load(turn, 0)) stalled(turn, 0, now);
    if (step > 0) {
      const message = receiveMessageOnPort(data.port);
      check(message !== undefined, `step ${step}: the previous message is readable at the first receive`);
      check((message!.message as { task: string }).task === text(data.size, step - 1), `step ${step}: whole message`);
      received++;
    }
    data.port.postMessage({ task: text(data.size, step) });
    if (step === 10) publishMarker(`${data.directory}/started`, 'started');
    Atomics.store(turn, 0, step + 1);
    Atomics.notify(turn, 0);
  }
  publishMarker(`${data.directory}/done-${data.side}`, String(received));
}

switch (data.mode) {
  case 'post-then-block': postThenBlock(data.port); break;
  case 'parent-post-then-block': postThenBlock(parentPort!); break;
  case 'parent-post-then-exit': parentPort!.postMessage({ task: text(data.size, data.seed) }); process.exit(0); break;
  case 'hold-unread': holdUnread(); break;
  case 'ping-pong': pingPong(); break;
  case 'blocked': blocked(); break;
  case 'reply': reply(); break;
  case 'exit-after-post': data.port.postMessage({ task: text(300_000, 5) }); process.exit(0); break;
  case 'sibling-sender': siblingSender(); break;
  case 'carried': carried(); break;
  case 'backlog': backlog(); break;
  case 'burst': burst(); break;
  default: throw new Error(`Unknown mode ${data.mode}`);
}
