import { strict as assert } from 'node:assert';

// Its own guest process: a new group, and a Store whose instance budget no other control spends.
const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/cross-worker.ts`], { stdout: 'pipe', stderr: 'inherit' });
const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
assert.equal(status, 0);
process.stdout.write(output);
