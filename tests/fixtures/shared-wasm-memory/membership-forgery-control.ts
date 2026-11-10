import { strict as assert } from 'node:assert';
import { memberTag } from './page-control.ts';

// Its own guest process: the forged spawns are checked against this process's own group.
const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/membership-forgery.ts`, memberTag('root-membership-forgery')], { stdout: 'pipe', stderr: 'inherit' });
const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
assert.equal(status, 0);
process.stdout.write(output);
