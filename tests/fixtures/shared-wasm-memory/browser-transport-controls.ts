import { strict as assert } from 'node:assert';
import { memberTag } from './page-control.ts';

// Each runs in its own guest process: a new group, region table and Store budget.
for (const name of [
  'cross-worker',
  'plain-sab',
  'plain-sab-guest',
  'shared-buffer-slice',
  'shared-buffer-alias',
  'shared-buffer-churn',
  'table-global',
  'table-global-guest',
  'worker-transport',
  'membership',
]) {
  const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/${name}.ts`, memberTag(`root-${name}`)], { stdout: 'pipe', stderr: 'inherit' });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  assert.equal(status, 0, name);
  process.stdout.write(output);
}
