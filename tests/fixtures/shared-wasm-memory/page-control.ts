// Facts only the embedding page can confirm. On the Browser host a guest sees a worker's exit
// before the page has stopped its agent, and the page's owner releases a member when the agent's
// native terminate returns, which still precedes the agent's end. Each boundary is named for what
// it proves. Off the Browser host there is no page, and a guest's own view is already the stop.
// A guest's process.pid is a fixed 1, so a member is named by a tag in its argv, read by the page.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = process.env.SHARED_WASM_PAGE_CONTROL;
const TAG = '--shared-wasm-member=';
const DEADLINE_MS = 30_000;
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

interface OwnerHolds { readonly groupHolds: number; readonly memberHolds: number; }

/** Blocks until the owner has released the tagged member: the broker's supported stop boundary. */
export function ownerReleased(name: string): OwnerHolds | undefined {
  if (root === undefined) return undefined;
  return JSON.parse(published(`${root}/gone/${name}`));
}

/**
 * Call before stopping a member whose end `agentClosed` will prove. Blocks until the page has seen
 * the agent hold its lifetime lock, and refuses at once if the page cannot observe that agent.
 */
export function agentArmed(name: string): void {
  if (root === undefined) return;
  const deadline = Date.now() + DEADLINE_MS;
  while (!existsSync(`${root}/armed/${name}`)) {
    if (existsSync(`${root}/unarmable/${name}`)) throw new Error(`The page cannot observe the agent of ${name}`);
    if (Date.now() > deadline) throw new Error(`The page never saw ${name} hold its lock`);
    pause(5);
  }
}

/** Blocks until the tagged member's armed agent has ended, seen as its held Web Lock being released. */
export function agentClosed(name: string): void {
  if (root === undefined) return;
  if (!existsSync(`${root}/armed/${name}`)) throw new Error(`${name} was stopped without an armed observer`);
  published(`${root}/closed/${name}`);
}

/** A member tagged `stall-open-*` has taken its holds and is blocked on the owner's reply. */
export function attachStalled(name: string): OwnerHolds {
  if (root === undefined) throw new Error('Stalling an attachment needs the embedding page');
  return JSON.parse(published(`${root}/stalled/${name}`));
}

/** A member tagged `fail-stop-*` had its native terminate fail, and the owner retains it. */
export function stopFailed(name: string): void {
  if (root === undefined) throw new Error('A failed stop needs the embedding page');
  published(`${root}/retained/${name}`);
}

/** The group owner's own counters, from Waffle's GroupOwner.snapshot() on the page. */
export interface OwnerSnapshot { readonly pins: number; readonly regions: number; readonly holds: number; readonly published: number; readonly members: number; }
let snapshotRequests = 0;

/**
 * Asks the page for the tagged member's group owner counters and blocks for the answer. The page
 * samples the owner only after reading this request, under a name used once, so the answer is
 * never older than the call. Off the Browser host there is no owner to ask.
 */
export function ownerSnapshot(name: string): OwnerSnapshot | undefined {
  if (root === undefined) return undefined;
  const request = `${name}.${Date.now()}-${snapshotRequests++}`;
  writeFileSync(`${root}/snapshot-request/${request}`, '');
  return JSON.parse(published(`${root}/snapshot/${request}`));
}
