import { strict as assert } from 'node:assert';

// Each runs in its own guest process: a new group, region table and Store budget.
for (const name of [
  'shared-buffer-slice',
  'shared-buffer-alias',
  'shared-buffer-growable',
  'shared-buffer-churn',
  'plain-sab',
  'plain-sab-guest',
  'table-global',
  'table-global-guest',
]) {
  const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/${name}.ts`], { stdout: 'pipe', stderr: 'inherit' });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  assert.equal(status, 0, name);
  process.stdout.write(output);
}
