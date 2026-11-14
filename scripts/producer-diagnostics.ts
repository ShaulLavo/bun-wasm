import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function retain(action: () => void): void {
  try { action(); }
  catch (error) { console.error('Producer diagnostic retention failed:', error); }
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise(resolve => {
    child.once('error', error => { console.error(error.message); resolve(127); });
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
}

export function producerEvent(phase: string, event: string): void {
  const started = Number(process.env.BUN_WASM_PRODUCER_STARTED_MS ??= String(Date.now()));
  const line = `${new Date().toISOString()} elapsed_ms=${Date.now() - started} phase=${phase} ${event}\n`;
  process.stdout.write(line);
  const directory = process.env.BUN_WASM_PRODUCER_DIAGNOSTICS;
  if (directory) retain(() => appendFileSync(join(directory, 'phases.log'), line));
}

export async function producerPhase<T>(phase: string, action: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  producerEvent(phase, 'start');
  try {
    const result = await action();
    producerEvent(phase, `end duration_ms=${Math.round(performance.now() - started)} status=0`);
    return result;
  } catch (error) {
    producerEvent(phase, `end duration_ms=${Math.round(performance.now() - started)} status=failed`);
    throw error;
  }
}

async function supervise(directory: string, deadline: number, command: string[]): Promise<number> {
  if (!Number.isSafeInteger(deadline) || command.length === 0) throw new Error('Expected an absolute deadline in milliseconds and a command');
  mkdirSync(directory, { recursive: true });
  process.env.BUN_WASM_PRODUCER_DIAGNOSTICS = directory;
  process.env.BUN_WASM_PRODUCER_STARTED_MS = String(Date.now());
  retain(() => writeFileSync(join(directory, 'phases.log'), ''));
  retain(() => writeFileSync(join(directory, 'output-tail.log'), ''));
  retain(() => writeFileSync(join(directory, 'status.json'), JSON.stringify({ state: 'running', deadline }) + '\n'));
  producerEvent('producer', 'start');
  const seconds = Math.floor((deadline - Date.now()) / 1000);
  if (seconds <= 0) {
    producerEvent('producer', 'end status=124 deadline-already-expired');
    retain(() => writeFileSync(join(directory, 'status.json'), JSON.stringify({ state: 'finished', status: 124 }) + '\n'));
    return 124;
  }
  // Reuse the existing descendant teardown, including the private cache server.
  const supervisor = fileURLToPath(new URL('./run-with-timeout.mts', import.meta.url));
  const child = spawn('bun', [supervisor, String(seconds)].concat(command), { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = Buffer.alloc(0);
  const capture = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-64 * 1024);
    retain(() => {
      writeFileSync(join(directory, 'output-tail.log.tmp'), tail);
      renameSync(join(directory, 'output-tail.log.tmp'), join(directory, 'output-tail.log'));
    });
  };
  child.stdout.on('data', (chunk: Buffer) => { process.stdout.write(chunk); capture(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); capture(chunk); });
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
    const handler = () => { child.kill(signal); };
    process.on(signal, handler);
    return { signal, handler };
  });
  let closed = false;
  const completion = waitForChild(child).then(status => { closed = true; return status; });
  try {
    const status = await completion;
    producerEvent('producer', `end status=${status}`);
    retain(() => writeFileSync(join(directory, 'status.json'), JSON.stringify({ state: 'finished', status, deadline }) + '\n'));
    return status;
  } finally {
    if (!closed) { child.kill('SIGTERM'); await completion; }
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}

if (import.meta.main) {
  const [mode, value, ...args] = process.argv.slice(2);
  if (mode === 'run' && value && args[0]) {
    process.exitCode = await supervise(value, Number(args[0]), args.slice(1));
  } else if (mode === 'phase' && value && args[0]) {
    let status = 1;
    await producerPhase(value, () => {
      const result = spawnSync(args[0]!, args.slice(1), { stdio: 'inherit' });
      status = result.error ? 127 : result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
      if (result.error) throw result.error;
      if (status !== 0) throw new Error(`${value} failed with status ${status}`);
    }).catch(error => { console.error(error.message); process.exitCode = status; });
  } else {
    throw new Error('Usage: producer-diagnostics.ts run DIRECTORY DEADLINE_MS COMMAND [ARGS...] | phase NAME COMMAND [ARGS...]');
  }
}
