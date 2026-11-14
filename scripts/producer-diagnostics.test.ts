import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { producerPhase } from './producer-diagnostics.ts';
import { selectChecks } from './test-checks.ts';

const diagnostics = join(import.meta.dir, 'producer-diagnostics.ts');

function execute(root: string, script: string, seconds = 15) {
  return spawnSync(process.execPath, [diagnostics, 'run', root, String(Date.now() + seconds * 1000), 'bash', '-c', script],
    { encoding: 'utf8', timeout: 20000 });
}

test('quality owns the producer diagnostics controls', () => {
  expect(selectChecks('quality')).toContain('scripts/producer-diagnostics.test.ts');
});

test('capture phases preserve their result and rethrow the original failure', async () => {
  expect(await producerPhase('capture-control', () => 42)).toBe(42);
  const failure = new Error('original capture error');
  await expect(producerPhase('capture-control', () => { throw failure; })).rejects.toBe(failure);
});

test.each([0, 23])('retains the final bounded stdout/stderr and phase status for exit %s', status => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-producer-'));
  try {
    const command = `printf '%70000s' x; echo final-stdout; echo final-stderr >&2; exit ${status}`;
    const result = execute(root, `"${process.execPath}" "${diagnostics}" phase cargo-control bash -c '${command}'`);
    expect(result.status, result.stderr).toBe(status);
    const phases = readFileSync(join(root, 'phases.log'), 'utf8');
    expect(phases.match(/phase=[\w-]+ (?:start|end)/g)).toEqual([
      'phase=producer start', 'phase=cargo-control start', 'phase=cargo-control end', 'phase=producer end',
    ]);
    expect(phases).toMatch(/elapsed_ms=\d+/);
    expect(phases).toMatch(/duration_ms=\d+/);
    const tail = readFileSync(join(root, 'output-tail.log'));
    expect(tail.length).toBeLessThanOrEqual(65536);
    expect(tail.toString()).toContain('final-stdout');
    expect(tail.toString()).toContain('final-stderr');
    expect(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))).toMatchObject({ state: 'finished', status });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an expired job envelope fails without starting the producer', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-producer-'));
  try {
    const result = execute(root, `touch "${join(root, 'unexpected')}"`, -1);
    expect(result.status, result.stderr).toBe(124);
    expect(existsSync(join(root, 'unexpected'))).toBe(false);
    expect(readFileSync(join(root, 'phases.log'), 'utf8')).toContain('deadline-already-expired');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a deadline retains the active phase and kills its child before returning failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-producer-'));
  try {
    const stub = join(root, 'stub.sh');
    writeFileSync(stub, `echo $$ > "${join(root, 'pid')}"; echo stalled-output; exec sleep 60\n`);
    const result = execute(root, `exec "${process.execPath}" "${diagnostics}" phase stalled-cargo bash "${stub}"`, 2);
    expect(result.status, result.stderr).toBe(124);
    const phases = readFileSync(join(root, 'phases.log'), 'utf8');
    expect(phases).toContain('phase=stalled-cargo start');
    expect(phases).toContain('phase=producer end status=124');
    expect(readFileSync(join(root, 'output-tail.log'), 'utf8')).toContain('stalled-output');
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

test('interruption preserves output and returns the signal failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-producer-'));
  const child = spawn(process.execPath, [diagnostics, 'run', root, String(Date.now() + 15000), 'bash', '-c', 'echo ready; exec sleep 60'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.resume();
  try {
    while (!output.includes('ready')) await once(child.stdout, 'data');
    child.kill('SIGTERM');
    expect((await closed)[0]).toBe(143);
    expect(readFileSync(join(root, 'output-tail.log'), 'utf8')).toContain('ready');
    expect(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))).toMatchObject({ state: 'finished', status: 143 });
  } finally {
    child.kill('SIGTERM');
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
