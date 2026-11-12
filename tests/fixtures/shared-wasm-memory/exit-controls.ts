import { strict as assert } from 'node:assert';

for (const [mode, status] of [['call', 7], ['start', 9]]) {
  const child = Bun.spawnSync([process.execPath, 'run', `${import.meta.dir}/exit-child.ts`, String(mode)], { stdout: 'pipe', stderr: 'pipe' });
  assert.equal(child.exitCode, status, child.stderr.toString());
  assert.equal(child.stdout.toString(), '');
}
console.log('shared-wasm-memory callback exits: pass');
