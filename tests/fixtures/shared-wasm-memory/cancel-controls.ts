import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';

const LIMIT_MS = 30_000;
function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${LIMIT_MS} ms`)), LIMIT_MS); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) await Bun.sleep(5);
}

// A blocking nested wait32 and a JS Atomics.wait inside a nested callback both end with the member.
for (const mode of ['nested', 'js']) {
  const marker = `${import.meta.dir}/cancel-ready-${mode}`;
  const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/cancel-child.ts`, mode, marker], { stdout: 'pipe', stderr: 'pipe' });
  await bounded(waitForFile(marker), `${mode} readiness`);
  child.kill('SIGTERM');
  assert.equal(await bounded(child.exited, `${mode} exit`), 143);
}
console.log('shared-wasm-memory wait cancellation: pass');
