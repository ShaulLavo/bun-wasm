// Stage 2 of the memory ceiling (docs/memory-ceiling.md) in a real shared-group guest: the group
// address space is 2 GiB, and its members together hold at most the 1 GiB guest maximum.
// Runs as the root guest, so its group is the only one charged to the runtime's backing budget
// once the member-cap guest below has exited. Standard output is the same on every engine and
// host; addresses and page counts go to standard error.
import { strict as assert } from 'node:assert';
import { closeSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { bunStringRoundTrip, linearMemoryBytes } from 'bun:internal-for-testing';

const PAGE = 65536;
const MiB = 2 ** 20;
const END = 2 ** 31;
const ROLLDOWN = { initial: 16384, maximum: 65536, shared: true } as const;
const note = (label: string, value: unknown) => console.error(`address-space ${label}: ${JSON.stringify(value)}`);
const refused = (error: unknown) => error instanceof RangeError && error.message.includes('region admission: NoMem');

// The member cap runs first, in its own guest, while this one is still small.
const capGuest = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/member-cap.ts`], { stdout: 'pipe', stderr: 'inherit' });
const [capOutput, capStatus] = await Promise.all([new Response(capGuest.stdout).text(), capGuest.exited]);
assert.equal(capStatus, 0, 'member cap guest');
process.stdout.write(capOutput);

// Stock Rolldown's descriptor. Its 1 GiB of initial bytes now fit beside this member.
const before = linearMemoryBytes();
const memory = new WebAssembly.Memory(ROLLDOWN);
const shared = memory.buffer;
assert.ok(shared instanceof SharedArrayBuffer);
note('group bytes before and after the Rolldown memory', [before, linearMemoryBytes()]);
console.log('rolldown descriptor admitted', true, 'bytes', shared.byteLength);

// A second one cannot fit. It is refused whole and the first is untouched.
let second = false;
try { new WebAssembly.Memory(ROLLDOWN); } catch (error) { second = refused(error); }
console.log('second rolldown memory refused', second, 'unchanged', memory.buffer === shared && shared.byteLength === ROLLDOWN.initial * PAGE);

// Host reads and writes from views at the top of the region, above 1 GiB of group addresses.
const bytes = new Uint8Array(shared);
const top = bytes.length;
const source = bytes.subarray(top - 2 * 4096, top - 4096);
const target = bytes.subarray(top - 4096, top);
for (let index = 0; index < source.length; index++) source[index] = (index * 31 + 7) & 0xff;
const path = `${import.meta.dir}/region-top.bin`;
const file = openSync(path, 'w+');
assert.equal(writeSync(file, source, 0, source.length, 0), source.length);
assert.equal(readSync(file, target, 0, target.length, 0), target.length);
closeSync(file);
unlinkSync(path);
const text = 'top of the region: café ✓ 東京';
const encoded = Buffer.from(text, 'utf8');
bytes.set(encoded, top - 2 * 4096 - encoded.length);
const decoded = Buffer.from(bytes.subarray(top - 2 * 4096 - encoded.length, top - 2 * 4096)).toString('utf8');
console.log('region top: file round trip', target.every((value, index) => value === source[index]), 'text', decoded === text);

// A worker joins this group, attaches the same memory and writes through Atomics.
const words = new Int32Array(shared);
const cell = words.length - 4096;
const worker = new Worker(`${import.meta.dir}/worker.ts`, { workerData: { memory, cell } });
const exited = new Promise<number>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
const seen = await new Promise<number>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
assert.equal(await exited, 0, 'worker');
console.log('worker shares the memory', Atomics.load(words, cell) === 0x5eed && seen === shared.byteLength);

// Growth inside the reservation works; growth past it is refused and changes nothing.
const grown = memory.grow(1);
const afterGrow = memory.buffer.byteLength;
let overgrown = false;
try { memory.grow(2000); } catch (error) { overgrown = error instanceof RangeError; }
console.log('grow one page', grown === ROLLDOWN.initial && afterGrow === (ROLLDOWN.initial + 1) * PAGE, 'grow 2000 refused', overgrown,
  'unchanged', memory.buffer.byteLength === afterGrow);

// Live ballast in 16 MiB blocks, every one of them granted, until less than 208 MiB of the
// group is left. The allocator gives each block the smallest free chunk that fits, so no free
// chunk below the ballast reaches 16 MiB afterwards and a 17 MiB payload is built past it.
// Each encoding needs temporary strings and several native copies. Collect them between independent
// round trips while the live ballast keeps every payload in the same high-address window.
const ballast: Uint8Array[] = [];
while (END - linearMemoryBytes() > 208 * MiB) {
  const block = new Uint8Array(16 * MiB);
  block[block.length - 1] = ballast.length & 0xff;
  ballast.push(block);
}
note('group bytes after ballast', linearMemoryBytes());
const size = 17 * MiB;
const payloads: Record<string, () => Buffer> = {
  latin1: () => Buffer.from('café crème '.repeat(size / 11 + 1), 'latin1'),
  utf8: () => Buffer.from('東京 ✓ café '.repeat(size / 16 + 1), 'utf8'),
  utf16le: () => Buffer.from('🦊é'.repeat(size / 6 + 1), 'utf16le'),
};
function roundTrip(encoding: string, build: () => Buffer): void {
  const payload = build();
  const result = bunStringRoundTrip(payload, encoding);
  note(`${encoding} string address`, result.address);
  console.log(encoding, 'near the 2 GiB end', result.address >= END - 224 * MiB && result.address < END, 'identical', Buffer.compare(result.bytes, payload) === 0);
}
for (const [encoding, build] of Object.entries(payloads)) {
  roundTrip(encoding, build);
  Bun.gc(true);
}
note('group bytes at the end', linearMemoryBytes());
console.log('ballast intact', ballast.every((block, index) => block[block.length - 1] === (index & 0xff)), 'group within 2 GiB', linearMemoryBytes() <= END);
