import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';

type Data = { mode: string; port: MessagePort; gate: SharedArrayBuffer; check: string; count: number };
const data: Data = workerData;

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

switch (data.mode) {
  case 'blocked': blocked(); break;
  case 'reply': reply(); break;
  case 'exit-after-post': data.port.postMessage({ task: text(300_000, 5) }); process.exit(0); break;
  case 'sibling-sender': siblingSender(); break;
  case 'carried': carried(); break;
  case 'backlog': backlog(); break;
  case 'burst': burst(); break;
  default: throw new Error(`Unknown mode ${data.mode}`);
}
