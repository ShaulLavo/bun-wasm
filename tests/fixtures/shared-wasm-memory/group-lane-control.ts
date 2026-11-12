import { strict as assert } from 'node:assert';

// Each in its own guest process: a new group whose ledger and lanes no other control shares.
for (const name of ['group-lane', 'group-lane-lifetime']) {
  const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/${name}.ts`], { stdout: 'pipe', stderr: 'inherit' });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  assert.equal(status, 0, name);
  process.stdout.write(output);
}
