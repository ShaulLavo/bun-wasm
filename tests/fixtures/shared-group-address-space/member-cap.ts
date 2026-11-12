// Runs alone in its own guest, with no nested memory, so the cumulative member cap is reached
// before the group's address space: the members of one group hold at most the 1 GiB guest maximum.
import { linearMemoryBytes } from 'bun:internal-for-testing';

const PAGE = 65536;
const MiB = 2 ** 20;
const CAP = 2 ** 30;
const note = (label: string, value: unknown) => console.error(`address-space ${label}: ${JSON.stringify(value)}`);

// Live 16 MiB blocks until one is refused. The refusal is an ordinary allocation failure.
const ballast: Uint8Array[] = [];
let failure: unknown;
while (failure === undefined && ballast.length < 128) {
  try { ballast.push(new Uint8Array(16 * MiB)); } catch (error) { failure = error ?? new Error('refused'); }
}
const full = linearMemoryBytes();
// Give the engine room to report before anything else is allocated.
ballast.length -= 2;
note('group bytes at the member cap', full);
note('blocks granted', ballast.length + 2);
// Page zero is the group's own. The last refused request was for less than 17 MiB.
const atCap = full <= CAP + PAGE && full > CAP - 17 * MiB;

// Regions are not member pages: a shared buffer is still admitted, above the capped members.
let region = false;
try {
  const buffer = new SharedArrayBuffer(32 * MiB);
  const view = new Uint8Array(buffer);
  view[view.length - 1] = 9;
  region = view[view.length - 1] === 9 && linearMemoryBytes() >= full + 32 * MiB;
} catch (error) { note('shared buffer', String(error)); }
note('group bytes with the shared buffer', linearMemoryBytes());
console.log('member cap: refused at 1 GiB', atCap, 'catchable', failure !== undefined, 'regions still admitted', region);
