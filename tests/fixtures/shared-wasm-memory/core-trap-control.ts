import { strict as assert } from 'node:assert';

const child = Bun.spawnSync([process.execPath, 'run', `${import.meta.dir}/core-trap-child.ts`], { stdout: 'pipe', stderr: 'pipe' });
assert.equal(child.exitCode, 134, child.stderr.toString());
assert.equal(child.stdout.toString(), '');
console.log('shared-wasm-memory core trap: pass');
