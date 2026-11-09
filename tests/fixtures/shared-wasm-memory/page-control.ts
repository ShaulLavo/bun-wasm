// Facts only the embedding page can confirm. On the Browser host a guest sees a worker's exit
// before the page has stopped its agent, so "stopped" here means the owner released its member.
// Off the Browser host there is no page, and a guest's own view is already the stop. A guest's
// process.pid is a fixed 1, so a member is named by a tag in its argv, which the page reads.
import { existsSync, readFileSync } from 'node:fs';

const root = process.env.SHARED_WASM_PAGE_CONTROL;
export const pageControlled = root !== undefined;
const TAG = '--shared-wasm-member=';
const DEADLINE_MS = 30_000;
// Worker.terminate() returns at once, but Blink only forces out a thread blocked in Atomics.wait
// two seconds later. Until then V8 still lists the waiter, so wait past that delay.
const UNWIND_MS = 3000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function pause(ms: number) { Atomics.wait(sleeper, 0, 0, ms); }

function published(path: string): string {
  const deadline = Date.now() + DEADLINE_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`The page never confirmed ${path}`);
    pause(5);
  }
  return readFileSync(path, 'utf8');
}

/** The argument that lets the page recognize a member started with it. */
export function memberTag(name: string): string { return `${TAG}${name}`; }

/** This process's own tag, from a spawn or Worker argv. */
export function ownMember(): string {
  const argument = process.argv.find(value => value.startsWith(TAG));
  if (!argument) throw new Error('This member has no page tag');
  return argument.slice(TAG.length);
}

/** The id of the group whose owner admitted the tagged member. */
export function groupOf(name: string): string {
  if (root === undefined) throw new Error('Group ids need the embedding page');
  return published(`${root}/group/${name}`);
}

/** Blocks until the owner has released the tagged member, the supported physical-stop boundary. */
export function stoppedPhysically(name: string): void {
  if (root === undefined) return;
  published(`${root}/gone/${name}`);
  pause(UNWIND_MS);
}
