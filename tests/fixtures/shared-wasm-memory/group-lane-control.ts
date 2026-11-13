import { strict as assert } from 'node:assert';

// In its own guest process: a new group whose ledger and lanes no other control shares. The
// lifetime run is this fixture's other command (`cmd.lifetime`, group-lane-lifetime-control.ts).
for (const name of ['group-lane']) {
  const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/${name}.ts`], { stdout: 'pipe', stderr: 'inherit' });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  assert.equal(status, 0, name);
  process.stdout.write(output);
}
