import { createNativeGrowableBuffer, nativeSharedGrow, nativeSharedLength } from "./native.ts";

export const overflowLimit = 64 * 1024 * 1024;
export const overflowBudget = 128 * 1024 * 1024;
export const overflowPage = 65536;
const poolLaneCount = 32;
export const poolChargedWord = 27, poolDisposedWord = 28, poolSlotStart = 29;
export const poolControlWords = poolSlotStart + poolLaneCount * 2 * 3;
const slotEmpty = 0, slotReserved = 1, slotPublished = 2, slotCopying = 3, slotClosed = 4;
export type SlotPair = readonly [SharedArrayBuffer, SharedArrayBuffer];
export interface OverflowGrant { readonly slots: readonly SlotPair[]; }
export interface LaneOverflow { readonly control: Int32Array; readonly slots: SlotPair | null; readonly index: number; }
const NativeBytes = Uint8Array;
const decoder = new TextDecoder("utf-8", { fatal: true });
const load = Atomics.load, store = Atomics.store, cas = Atomics.compareExchange, sub = Atomics.sub, or = Atomics.or;
export function laneError(message: string) { return new DOMException(message, "DataCloneError"); }
export function assertPoolActive(control: Int32Array) {
  if (load(control, poolDisposedWord)) throw laneError("Shared-object runtime is closed");
}
export function createOverflowGrant(): OverflowGrant | null {
  try {
    return { slots: Array.from({ length: poolLaneCount }, (): SlotPair => [createNativeGrowableBuffer(overflowLimit), createNativeGrowableBuffer(overflowLimit)]) };
  } catch { return null; }
}
export function slotWord(index: number, side: 0 | 1) { return poolSlotStart + (index * 2 + side) * 3; }
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
function charge(control: Int32Array, delta: number) {
  for (;;) {
    assertPoolActive(control);
    const used = load(control, poolChargedWord);
    if (used < 0 || used > overflowBudget) throw laneError("Invalid large-message budget");
    if (delta > overflowBudget - used) throw laneError("Large-message runtime budget exceeded");
    if (cas(control, poolChargedWord, used, used + delta) === used) return;
  }
}
function growSlot(control: Int32Array, buffer: SharedArrayBuffer, length: number) {
  const before = nativeSharedLength(buffer), target = Math.ceil(length / overflowPage) * overflowPage;
  const delta = Math.max(0, target - before);
  if (!delta) return;
  charge(control, delta);
  try { nativeSharedGrow(buffer, target); }
  catch (error) {
    const after = nativeSharedLength(buffer);
    if (after < before || after > target) { store(control, poolDisposedWord, 1); throw laneError("Invalid large-message growth"); }
    sub(control, poolChargedWord, target - after);
    throw error;
  }
  if (nativeSharedLength(buffer) !== target) { store(control, poolDisposedWord, 1); throw laneError("Invalid large-message growth"); }
}
export function reserveOverflow(overflow: LaneOverflow, side: 0 | 1, bytes: Uint8Array) {
  const { control, slots, index } = overflow;
  assertPoolActive(control);
  if (!slots) throw laneError("Large-message overflow is unavailable");
  if (bytes.byteLength > overflowLimit) throw laneError(`Message exceeds the ${overflowLimit} byte encoded limit between processes`);
  const word = slotWord(index, side), buffer = slots[side];
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
    growSlot(control, buffer, bytes.byteLength);
    new NativeBytes(buffer, 0, bytes.byteLength).set(bytes);
    store(control, word + 2, bytes.byteLength);
    assertPoolActive(control);
    if (load(control, word) & slotClosed) throw laneError("MessagePort peer is closed");
    return { generation, abort, commit() { if (settled) return; settled = true; transition(control, word, slotReserved, slotPublished); } };
  } catch (error) { abort(); throw error; }
}
export function copyOverflow(overflow: LaneOverflow, side: 0 | 1, generation: number, length: number): string {
  const { control, slots, index } = overflow, word = slotWord(index, side);
  if (!slots || generation === 0 || (load(control, word + 1) >>> 0) !== generation
    || load(control, word + 2) !== length || length > overflowLimit || length > nativeSharedLength(slots[side])) throw laneError("Invalid large-message descriptor");
  transition(control, word, slotPublished, slotCopying);
  try {
    const copy = new NativeBytes(length);
    copy.set(new NativeBytes(slots[side], 0, length));
    return decoder.decode(copy);
  } catch (error) { transition(control, word, slotCopying, slotPublished); throw error; }
}
export function creditOverflow(overflow: LaneOverflow, side: 0 | 1) {
  const word = slotWord(overflow.index, side);
  store(overflow.control, word + 2, 0);
  transition(overflow.control, word, slotCopying, slotEmpty);
}
