import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = ['index.ts', 'mixed-backend.ts'];

export function runSharedNestedNative(program: string, launcher: string) {
  const results = fixtures.map(fixture => {
    const command = ['--wasm', resolve(program), '--', 'run', `tests/shared-wasm-memory/${fixture}`];
    const started = performance.now();
    const result = spawnSync(resolve(launcher), command, {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, BUN_WASM_TRACE: '1' }, maxBuffer: 8 << 20,
    });
    const wallMs = performance.now() - started;
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${fixture}: guest failed with ${result.signal ?? result.status}`);
    if (!result.stdout.includes(': pass')) throw new Error(`${fixture}: missing success assertion`);
    return { fixture, wallMs, command: [resolve(launcher)].concat(command) };
  });
  return { kind: 'real-quickjs-shared-group-native', results };
}

if (import.meta.main) {
  const [program, launcher] = process.argv.slice(2);
  if (!program || !launcher) throw new Error('Usage: source env.sh; bun scripts/shared-nested-native.ts GROUP_PROGRAM NATIVE_LAUNCHER');
  // A pending fixture is never converted into a pass because an artifact is absent.
  if (!statSync(resolve(program)).isFile() || !statSync(resolve(launcher)).isFile()) throw new Error('Both inputs must be regular files');
  console.log(JSON.stringify(runSharedNestedNative(program, launcher), null, 2));
}
