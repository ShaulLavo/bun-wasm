import { strict as assert } from 'node:assert';

// The lifetime run starts 200 workers in turn inside one guest and group. It is this fixture's
// second command (`cmd.lifetime`) so that it has the command time bound to itself. Each guest
// here runs to its end, output and exit status, before the next starts.
//
// The guest after it is a new group in the same launcher: whatever the churn left behind, the
// launcher must still serve one. It is the `plain-sab` control, which the default command
// ran after the lane controls before this command existed.
for (const name of ['group-lane-lifetime', 'plain-sab']) {
  console.error(JSON.stringify({ lifetimePhase: 'start', name, time: Date.now() }));
  const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/${name}.ts`], { stdout: 'pipe', stderr: 'inherit' });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  console.error(JSON.stringify({ lifetimePhase: 'exited', name, status, time: Date.now() }));
  assert.equal(status, 0, name);
  process.stdout.write(output);
}
