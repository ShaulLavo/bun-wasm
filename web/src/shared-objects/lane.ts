// A MessageChannel's own pair of single-producer single-consumer byte rings in one shared backing.
// The current owner of the port on side `s` is the only reader of ring `s` and the only writer of
// ring `1 - s`; a transfer hands both roles over with the port. A frame is complete and visible to
// the destination as soon as its commit returns, so a reply posted before a user Atomics.notify
// reaches the woken receiver's synchronous receive without any broker hop. Decoding it still needs
// every shared backing it names: one the destination doesn't hold yet attaches through its event loop.
import { createNativeSharedBuffer } from "./native.ts";
import { overflowLimit, assertPoolActive, closeOverflow, copyOverflow, creditOverflow, laneError, reserveOverflow } from "./lane-overflow.ts";
import type { LaneOverflow } from "./lane-overflow.ts";
export { overflowLimit, overflowBudget, poolChargedWord, poolDisposedWord, poolControlWords } from "./lane-overflow.ts";
const atomicLoad = Atomics.load, atomicStore = Atomics.store, atomicAdd = Atomics.add, atomicNotify = Atomics.notify, atomicWaitAsync = Atomics.waitAsync;
const NativeTextEncoder = TextEncoder, NativeTextDecoder = TextDecoder;
const encoder = new NativeTextEncoder(), decoder = new NativeTextDecoder("utf-8", { fatal: true });
// Per ring: write cursor, read cursor, wake signal, reader closed. Cursors are byte positions modulo 2^32.
const ringWords = 4;
const writeIndex = 0, readIndex = 1, signalIndex = 2, closedIndex = 3;
const headerBytes = 2 * ringWords * Int32Array.BYTES_PER_ELEMENT;
const ringBytes = 1024 * 1024;
const frameHeaderBytes = 4;
const overflowTag = 0xffffffff, descriptorBytes = 12;
export const inlineLaneLimit = ringBytes - frameHeaderBytes;
export const sharedLaneBytes = headerBytes + 2 * ringBytes;

export interface SharedLane {
  readonly buffer: SharedArrayBuffer;
  /**
   * Prepares a frame toward the peer; nothing is visible until commit. Null when the peer's ring
   * has no room now; throws DataCloneError for a frame beyond its encoded limit or a closed peer.
   */
  reserve(text: string): { commit(): void; abort(): void } | null;
  /** This side stops reading for good: the peer's later reservations throw. */
  close(): void;
  /** Whether the peer has stopped reading for good. */
  peerClosed(): boolean;
  /** Delivers every frame committed to this side, in order. */
  drain(consume: (text: string) => void): number;
  /** Calls `ready` after frames may have arrived on this side, until the returned stop is called. */
  watch(ready: () => void): () => void;
}

export function createSharedLaneBuffer(): SharedArrayBuffer {
  return createNativeSharedBuffer(sharedLaneBytes);
}

function align(bytes: number) { return (bytes + 3) & ~3; }

export function openSharedLane(buffer: SharedArrayBuffer, side: 0 | 1, overflow?: LaneOverflow): SharedLane {
  if (buffer.byteLength !== sharedLaneBytes) throw new DOMException("Invalid shared lane size", "DataCloneError");
  const inbound = ring(buffer, side), outbound = ring(buffer, side === 0 ? 1 : 0);
  const destination = side === 0 ? 1 : 0;
  let reserved = false;
  let terminal: unknown;
  function active() { if (overflow) assertPoolActive(overflow.control); }
  function reserve(text: string) {
    active();
    if (reserved) return null;
    if (atomicLoad(outbound.header, closedIndex)) throw laneError("MessagePort peer is closed");
    const bytes = encoder.encode(text), large = bytes.byteLength > inlineLaneLimit;
    if (large && !overflow) throw laneError(`Message exceeds the ${inlineLaneLimit} byte limit between processes`);
    if (large && bytes.byteLength > overflowLimit) throw laneError(`Message exceeds the ${overflowLimit} byte encoded limit between processes`);
    if (large && !overflow?.slots) throw laneError("Large-message overflow is unavailable");
    const descriptor = large ? new Uint8Array(descriptorBytes) : null;
    const descriptorView = descriptor ? new DataView(descriptor.buffer) : null;
    const need = large ? descriptorBytes : frameHeaderBytes + align(bytes.byteLength);
    const written = atomicLoad(outbound.header, writeIndex) >>> 0;
    const used = (written - (atomicLoad(outbound.header, readIndex) >>> 0)) >>> 0;
    if (used > ringBytes || written % 4 || (atomicLoad(outbound.header, readIndex) >>> 0) % 4) throw laneError("Invalid shared lane cursors");
    if (need > ringBytes - used) return null;
    // Allocate descriptor views and the caller token before claiming the overflow slot.
    if (descriptor && descriptorView) {
      descriptorView.setUint32(0, overflowTag, true); descriptorView.setUint32(8, bytes.byteLength, true);
      outbound.copyIn(descriptor, written);
    } else {
      outbound.view.setUint32(written % ringBytes, bytes.byteLength, true);
      outbound.copyIn(bytes, (written + frameHeaderBytes) >>> 0);
    }
    let slot: ReturnType<typeof reserveOverflow> | null = null;
    let prepared = true;
    const reservation = {
      commit() {
        if (!prepared) return;
        prepared = false; reserved = false;
        slot?.commit();
        atomicStore(outbound.header, writeIndex, (written + need) | 0);
        atomicAdd(outbound.header, signalIndex, 1); atomicNotify(outbound.header, signalIndex);
      },
      abort() { if (!prepared) return; prepared = false; reserved = false; slot?.abort(); },
    };
    slot = large && overflow ? reserveOverflow(overflow, destination, bytes) : null;
    try {
      (descriptor ? outbound.view : null)?.setUint32((written + frameHeaderBytes) % ringBytes, slot?.generation ?? 0, true);
      reserved = true;
      return reservation;
    } catch (error) { slot?.abort(); throw error; }
  }
  function poison(error: unknown): never {
    terminal = error ?? laneError("Shared lane consumption failed");
    atomicStore(inbound.header, closedIndex, 2);
    if (overflow) closeOverflow(overflow.control, overflow.index, side);
    throw terminal;
  }
  function frame(read: number, available: number) {
    if (available > ringBytes || available < frameHeaderBytes || read % 4 || available % 4) throw laneError("Invalid shared lane frame");
    const length = inbound.view.getUint32(read % ringBytes, true);
    if (length !== overflowTag) {
      const need = frameHeaderBytes + align(length);
      if (length > inlineLaneLimit || need > available) throw laneError("Invalid shared lane frame");
      return { text: decoder.decode(inbound.copyOut((read + frameHeaderBytes) >>> 0, length)), need, large: false };
    }
    if (!overflow || available < descriptorBytes) throw laneError("Invalid large-message descriptor");
    const descriptor = inbound.copyOut(read, descriptorBytes), view = new DataView(descriptor.buffer);
    const encodedLength = view.getUint32(8, true);
    if (encodedLength <= inlineLaneLimit) throw laneError("Invalid large-message descriptor length");
    return { text: copyOverflow(overflow, side, view.getUint32(4, true), encodedLength), need: descriptorBytes, large: true };
  }
  function drain(consume: (text: string) => void) {
    active();
    if (terminal) throw terminal;
    if (atomicLoad(inbound.header, closedIndex) === 2) throw laneError("Shared lane has a terminal error");
    if (atomicLoad(inbound.header, closedIndex)) return 0;
    let count = 0;
    for (;;) {
      const read = atomicLoad(inbound.header, readIndex) >>> 0, available = (atomicLoad(inbound.header, writeIndex) - read) >>> 0;
      if (!available) return count;
      let packet: ReturnType<typeof frame>;
      try { packet = frame(read, available); }
      catch (error) { if (error instanceof RangeError) throw error; return poison(error); }
      atomicStore(inbound.header, readIndex, (read + packet.need) | 0);
      if (packet.large && overflow) creditOverflow(overflow, side);
      if (atomicLoad(inbound.header, closedIndex)) return count;
      try { consume(packet.text); } catch (error) { return poison(error); }
      count++;
    }
  }
  function watch(ready: () => void) {
    let active = true;
    function arm(observed: number) {
      if (!active) return;
      const waiting = atomicWaitAsync(inbound.header, signalIndex, observed);
      if (waiting.async) void waiting.value.then(changed);
      else queueMicrotask(changed);
    }
    function changed() {
      if (!active) return;
      const observed = atomicLoad(inbound.header, signalIndex);
      ready(); arm(observed);
    }
    arm(atomicLoad(inbound.header, signalIndex));
    return () => {
      if (!active) return;
      active = false;
      atomicAdd(inbound.header, signalIndex, 1); atomicNotify(inbound.header, signalIndex);
    };
  }
  function close() {
    Atomics.compareExchange(inbound.header, closedIndex, 0, 1);
    if (overflow) closeOverflow(overflow.control, overflow.index, side);
    atomicAdd(inbound.header, signalIndex, 1); atomicNotify(inbound.header, signalIndex);
  }
  return { buffer, reserve, drain, watch, close, peerClosed: () => atomicLoad(outbound.header, closedIndex) !== 0 };
}

function ring(buffer: SharedArrayBuffer, side: 0 | 1) {
  const header = new Int32Array(buffer, side * ringWords * Int32Array.BYTES_PER_ELEMENT, ringWords);
  const offset = headerBytes + side * ringBytes;
  const bytes = new Uint8Array(buffer, offset, ringBytes), view = new DataView(buffer, offset, ringBytes);
  function copyIn(value: Uint8Array, position: number) {
    const start = position % ringBytes, first = Math.min(value.byteLength, ringBytes - start);
    bytes.set(value.subarray(0, first), start);
    bytes.set(value.subarray(first), 0);
  }
  function copyOut(position: number, length: number) {
    const start = position % ringBytes, first = Math.min(length, ringBytes - start), out = new Uint8Array(length);
    out.set(bytes.subarray(start, start + first));
    out.set(bytes.subarray(0, length - first), first);
    return out;
  }
  return { header, view, copyIn, copyOut };
}
