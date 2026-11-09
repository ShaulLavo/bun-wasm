// A Worker, or an ordinary process held open by its parent. Only the page says which group each joined.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { memberTag } from './page-control.ts';

const self = import.meta.path;

function leaveOnMessage(leave: () => void) { parentPort!.once('message', leave); }

function plain() {
  parentPort!.postMessage('ready');
  leaveOnMessage(() => process.exit(0));
}

function nested() {
  const inner = new Worker(self, { workerData: { mode: 'plain' }, argv: [memberTag(workerData.inner)] });
  inner.once('message', () => parentPort!.postMessage('ready'));
  inner.once('exit', () => process.exit(0));
  leaveOnMessage(() => inner.postMessage('leave'));
}

function ordinary() {
  const child = Bun.spawn([process.execPath, 'run', self, memberTag(workerData.inner)], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  parentPort!.postMessage('ready');
  leaveOnMessage(() => {
    child.stdin.end();
    void child.exited.then(() => process.exit(0));
  });
}

if (isMainThread) await Bun.stdin.text();
else ({ plain, nested, ordinary } as Record<string, () => void>)[workerData.mode]!();
