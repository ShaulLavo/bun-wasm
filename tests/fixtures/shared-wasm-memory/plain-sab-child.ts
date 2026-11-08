import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) throw new Error('Expected a worker');
const port = parentPort;

function bytes() {
  const buffer: SharedArrayBuffer = workerData.buffer;
  const view = new Uint8Array(buffer);
  const report = { length: buffer.byteLength, first: view[0], instance: buffer instanceof SharedArrayBuffer, outside: view[buffer.byteLength] };
  view[1] = 200;
  port.postMessage(report);
  port.on('message', (received: SharedArrayBuffer) => {
    new Uint8Array(received)[received.byteLength - 1] = 201;
    port.postMessage('wrote');
  });
}

function wake() {
  const words = new Int32Array(workerData.buffer as SharedArrayBuffer);
  const result = Atomics.wait(words, 0, 0, 10_000);
  let waking = 0;
  while (waking === 0) waking = Atomics.notify(words, 1, 1);
  Atomics.store(words, 1, 7);
  port.postMessage({ result, waking });
}

function slices() {
  port.on('message', (buffer: SharedArrayBuffer) => {
    const view = new Uint8Array(buffer);
    const contents = Array.from(view);
    if (view.length) view[0] = 222;
    port.postMessage({ length: buffer.byteLength, contents, instance: buffer instanceof SharedArrayBuffer });
  });
}

function creator() {
  const buffer = new SharedArrayBuffer(16);
  new Uint8Array(buffer)[0] = 55;
  port.postMessage(buffer);
  port.on('message', () => {});
}

function echo() {
  port.on('message', (buffer: SharedArrayBuffer) => port.postMessage(buffer));
}

const modes: Record<string, () => void> = { bytes, wake, slices, creator, echo };
const mode = modes[workerData.mode];
if (!mode) throw new Error('Unknown mode');
mode();
