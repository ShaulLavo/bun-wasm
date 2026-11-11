import { strict as assert } from 'node:assert';

/** Each runs in its own guest process: admission depends on the group's whole remaining room. */
export async function runReservationGuests(names: readonly string[]): Promise<void> {
  for (const name of names) {
    const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/${name}.ts`], { stdout: 'pipe', stderr: 'inherit' });
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    assert.equal(status, 0, name);
    process.stdout.write(output);
  }
}
