// The first guest of its own group: starts two workers that exchange spilled messages over a
// channel it created, then waits to be killed. The workers must not need it again.
import { MessageChannel, Worker } from 'node:worker_threads';

const directory = process.argv[2];
if (!directory) throw new Error('Missing result directory');
const child = `${import.meta.dir}/group-lane-child.ts`;
const turn = new SharedArrayBuffer(8);
const { port1, port2 } = new MessageChannel();
for (const [side, port] of [[0, port1], [1, port2]] as const) {
  new Worker(child, { workerData: { mode: 'ping-pong', gate: turn, port, side, count: 80, size: 100_000, directory }, transferList: [port] });
}
setInterval(() => {}, 1_000);
