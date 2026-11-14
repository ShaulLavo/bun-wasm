import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { producerPhase } from './producer-diagnostics.ts';
import { needsRust, needsSharedNative } from './ci-changes.ts';
import { selectChecks } from './test-checks.ts';

const diagnostics = join(import.meta.dir, 'producer-diagnostics.ts');

function execute(root: string, script: string, seconds = 15) {
  return spawnSync(process.execPath, [diagnostics, 'run', root, String(Date.now() + seconds * 1000), 'bash', '-c', script],
    { encoding: 'utf8', timeout: 20000 });
}

function stopRecordedChild(path: string): void {
  if (!existsSync(path)) return;
  try { process.kill(Number(readFileSync(path, 'utf8')), 'SIGKILL'); } catch {}
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

test('producer helper changes select the native proof owner and launcher', () => {
  expect(needsSharedNative(['scripts/producer-diagnostics.ts'])).toBe(true);
  expect(needsRust(['scripts/producer-diagnostics.ts'])).toBe(true);
  const recipe = readFileSync(join(import.meta.dir, 'build-native-profile.ts'), 'utf8');
  expect(recipe).toContain("'scripts/producer-diagnostics.ts'");
  const workflow = readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8');
  expect(workflow).toContain("'scripts/build-native-profile.ts', 'scripts/producer-diagnostics.ts', 'scripts/build-bun-core.sh'");
});

test('unwritable phase history preserves original action errors and successful results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-producer-'));
  const previous = process.env.BUN_WASM_PRODUCER_DIAGNOSTICS;
  process.env.BUN_WASM_PRODUCER_DIAGNOSTICS = root;
  mkdirSync(join(root, 'phases.log'));
  const failure = new Error('ORIGINAL_CAPTURE_FAILURE');
  try {
    await expect(producerPhase('broken-log', () => { throw failure; })).rejects.toBe(failure);
    expect(await producerPhase('successful-action', () => 42)).toBe(42);
  } finally {
    if (previous === undefined) delete process.env.BUN_WASM_PRODUCER_DIAGNOSTICS;
    else process.env.BUN_WASM_PRODUCER_DIAGNOSTICS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed tail retention forwards original output and preserves exit 23', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-producer-'));
  try {
    const result = execute(root, `mkdir "${join(root, 'output-tail.log.tmp')}"; echo ORIGINAL_FAILURE_23; exit 23`);
    expect(result.status, result.stderr).toBe(23);
    expect(result.stdout).toContain('ORIGINAL_FAILURE_23');
    expect(result.stderr).toContain('Producer diagnostic retention failed');
    expect(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))).toMatchObject({ state: 'finished', status: 23 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed tail retention still supervises active detached descendants', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-producer-'));
  const pidFile = join(root, 'detached-pid');
  try {
    const result = execute(root, `mkdir "${join(root, 'output-tail.log.tmp')}"; setsid bash -c 'echo $$ > "${pidFile}"; exec sleep 60' & echo READY_WITH_BROKEN_RETENTION; wait`, 2);
    expect(result.status, result.stderr).toBe(124);
    expect(result.stdout).toContain('READY_WITH_BROKEN_RETENTION');
    expect(result.stderr).toContain('Producer diagnostic retention failed');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    stopRecordedChild(pidFile);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
