import { createNativeGrowableBuffer, nativeSharedGrow, nativeSharedLength } from "./native.ts";

export const overflowLimit = 64 * 1024 * 1024;
export const overflowBudget = 128 * 1024 * 1024;
export const overflowPage = 65536;
const poolLaneCount = 32;
export const poolChargedWord = 27, poolDisposedWord = 28, poolSlotStart = 29;
// Per direction: phase, generation and frame length, then the offset and capacity of its arena extent.
export const poolSlotWords = 5;
const slotOffset = 3, slotCapacity = 4;
export const poolControlWords = poolSlotStart + poolLaneCount * 2 * poolSlotWords;
const slotEmpty = 0, slotReserved = 1, slotPublished = 2, slotCopying = 3, slotClosed = 4;
/**
 * One growable backing holds every direction's large frames. Its maximum is the runtime budget and
 * no more: an engine reserves a growable buffer's whole maximum as address space at construction,
 * and WebKit takes it from the fixed cage that Wasm memories also need.
 */
export interface OverflowGrant { readonly arena: SharedArrayBuffer; }
export interface LaneOverflow { readonly control: Int32Array; readonly arena: SharedArrayBuffer | null; readonly index: number; }
const NativeBytes = Uint8Array;
const decoder = new TextDecoder("utf-8", { fatal: true });
const load = Atomics.load, store = Atomics.store, cas = Atomics.compareExchange, or = Atomics.or;
export function laneError(message: string) { return new DOMException(message, "DataCloneError"); }
export function assertPoolActive(control: Int32Array) {
  if (load(control, poolDisposedWord)) throw laneError("Shared-object runtime is closed");
}
export function createOverflowGrant(): OverflowGrant | null {
  try { return { arena: createNativeGrowableBuffer(overflowBudget) }; }
  catch { return null; }
}
export function slotWord(index: number, side: 0 | 1) { return poolSlotStart + (index * 2 + side) * poolSlotWords; }
export function closeOverflow(control: Int32Array, index: number, side: 0 | 1) {
  or(control, slotWord(index, side), slotClosed);
}
function transition(control: Int32Array, word: number, from: number, to: number) {
  for (;;) {
    const state = load(control, word);
    if ((state & 3) !== from) throw laneError("Invalid large-message slot phase");
    if (cas(control, word, state, (state & slotClosed) | to) === state) return;
  }
}
/** Hands out the next arena bytes: `preferred` of them when the budget allows, otherwise `minimum`. */
function charge(control: Int32Array, preferred: number, minimum: number) {
  for (;;) {
    assertPoolActive(control);
    const start = load(control, poolChargedWord);
    if (start < 0 || start > overflowBudget) throw laneError("Invalid large-message budget");
    const size = preferred <= overflowBudget - start ? preferred : minimum;
    if (size > overflowBudget - start) throw laneError("Large-message runtime budget exceeded");
    if (cas(control, poolChargedWord, start, start + size) === start) return { start, size };
  }
}
/** Lengthens the extent ending at `end` where it is. Only the last extent handed out can do this. */
function extendLast(control: Int32Array, end: number, bytes: number) {
  assertPoolActive(control);
  return bytes <= overflowBudget - end && cas(control, poolChargedWord, end, end + bytes) === end;
}
/** Makes the arena at least `end` bytes long. Another sender may grow it past that at any moment. */
function back(control: Int32Array, arena: SharedArrayBuffer, end: number) {
  for (;;) {
    const before = nativeSharedLength(arena);
    if (before >= end) return;
    try { nativeSharedGrow(arena, end); }
    catch (error) {
      if (nativeSharedLength(arena) === before) throw error;
      continue;
    }
    if (nativeSharedLength(arena) < end) { store(control, poolDisposedWord, 1); throw laneError("Invalid large-message growth"); }
    return;
  }
}
/** Returns bytes charged for `[from, to)` that no growth backed, unless a later extent already follows. */
function refund(control: Int32Array, arena: SharedArrayBuffer, from: number, to: number) {
  const backed = Math.floor(nativeSharedLength(arena) / overflowPage) * overflowPage;
  cas(control, poolChargedWord, to, Math.min(to, Math.max(from, backed)));
}
/**
 * The start of the direction's extent once it holds `length` bytes. The caller holds the slot in
 * its reserved phase, so nothing else reads or moves the extent. An outgrown extent that cannot
 * lengthen in place is left charged and unused, and its replacement takes at least twice its size
 * so that slowly growing frames do not strand one extent each.
 */
function claimExtent(control: Int32Array, word: number, arena: SharedArrayBuffer, length: number) {
  const offset = load(control, word + slotOffset), capacity = load(control, word + slotCapacity);
  if (offset < 0 || capacity < 0 || capacity > overflowLimit || offset > overflowBudget - capacity) throw laneError("Invalid large-message extent");
  if (length <= capacity) return offset;
  const target = Math.ceil(length / overflowPage) * overflowPage;
  const inPlace = capacity > 0 && extendLast(control, offset + capacity, target - capacity);
  const moved = inPlace ? null : charge(control, Math.min(Math.max(target, capacity * 2), overflowLimit), target);
  const start = moved?.start ?? offset, size = moved?.size ?? target;
  try { back(control, arena, start + size); }
  catch (error) { refund(control, arena, moved ? start : offset + capacity, start + size); throw error; }
  store(control, word + slotOffset, start); store(control, word + slotCapacity, size);
  return start;
}
export function reserveOverflow(overflow: LaneOverflow, side: 0 | 1, bytes: Uint8Array) {
  const { control, arena, index } = overflow;
  assertPoolActive(control);
  if (!arena) throw laneError("Large-message overflow is unavailable");
  if (bytes.byteLength > overflowLimit) throw laneError(`Message exceeds the ${overflowLimit} byte encoded limit between processes`);
  const word = slotWord(index, side);
  const state = load(control, word);
  if (state & slotClosed) throw laneError("MessagePort peer is closed");
  if (state !== slotEmpty || cas(control, word, slotEmpty, slotReserved) !== slotEmpty) throw laneError("Large-message overflow slot is busy");
  let settled = false;
  function abort() {
    if (settled) return;
    settled = true; store(control, word + 2, 0); transition(control, word, slotReserved, slotEmpty);
  }
  try {
    const previous = load(control, word + 1) >>> 0;
    if (previous === 0xffffffff) throw laneError("Large-message generation exhausted");
    const generation = previous + 1;
    store(control, word + 1, generation);
    new NativeBytes(arena, claimExtent(control, word, arena, bytes.byteLength), bytes.byteLength).set(bytes);
    store(control, word + 2, bytes.byteLength);
    assertPoolActive(control);
    if (load(control, word) & slotClosed) throw laneError("MessagePort peer is closed");
    return { generation, abort, commit() { if (settled) return; settled = true; transition(control, word, slotReserved, slotPublished); } };
  } catch (error) { abort(); throw error; }
}
export function copyOverflow(overflow: LaneOverflow, side: 0 | 1, generation: number, length: number): string {
  const { control, arena, index } = overflow, word = slotWord(index, side);
  const offset = load(control, word + slotOffset);
  if (!arena || generation === 0 || (load(control, word + 1) >>> 0) !== generation || load(control, word + 2) !== length || length > overflowLimit
    || length > load(control, word + slotCapacity) || offset < 0 || offset > nativeSharedLength(arena) - length) throw laneError("Invalid large-message descriptor");
  transition(control, word, slotPublished, slotCopying);
  try {
    const copy = new NativeBytes(length);
    copy.set(new NativeBytes(arena, offset, length));
    return decoder.decode(copy);
  } catch (error) { transition(control, word, slotCopying, slotPublished); throw error; }
}
export function creditOverflow(overflow: LaneOverflow, side: 0 | 1) {
  const word = slotWord(overflow.index, side);
  store(overflow.control, word + 2, 0);
  transition(overflow.control, word, slotCopying, slotEmpty);
}
