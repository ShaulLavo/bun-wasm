// A MessageChannel's own pair of single-producer single-consumer byte rings in one shared backing.
// The current owner of the port on side `s` is the only reader of ring `s` and the only writer of
// ring `1 - s`; a transfer hands both roles over with the port. A committed frame is readable by
// the destination as soon as `write` returns, so a reply posted before a user Atomics.notify is
// visible to the woken receiver's synchronous receive without any broker hop.
const atomicLoad = Atomics.load, atomicStore = Atomics.store, atomicAdd = Atomics.add, atomicNotify = Atomics.notify, atomicWaitAsync = Atomics.waitAsync;
const NativeTextEncoder = TextEncoder, NativeTextDecoder = TextDecoder;
const encoder = new NativeTextEncoder(), decoder = new NativeTextDecoder("utf-8", { fatal: true });
// Per ring: write cursor, read cursor, wake signal. Cursors are byte positions modulo 2^32.
const ringWords = 4;
const writeIndex = 0, readIndex = 1, signalIndex = 2;
const headerBytes = 2 * ringWords * Int32Array.BYTES_PER_ELEMENT;
const ringBytes = 1024 * 1024;
const frameHeaderBytes = 4;
export const sharedLaneBytes = headerBytes + 2 * ringBytes;

export interface SharedLane {
  readonly buffer: SharedArrayBuffer;
  /**
   * Prepares a frame toward the peer; nothing is visible until commit. Null when the peer's ring
   * has no room now; throws DataCloneError for a frame larger than the whole ring.
   */
  reserve(text: string): { commit(): void; abort(): void } | null;
  /** Delivers every frame committed to this side, in order. */
  drain(consume: (text: string) => void): number;
  /** Calls `ready` after frames may have arrived on this side, until the returned stop is called. */
  watch(ready: () => void): () => void;
}

export function createSharedLaneBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(sharedLaneBytes);
}

function align(bytes: number) { return (bytes + 3) & ~3; }

export function openSharedLane(buffer: SharedArrayBuffer, side: 0 | 1): SharedLane {
  if (buffer.byteLength !== sharedLaneBytes) throw new DOMException("Invalid shared lane size", "DataCloneError");
  const inbound = ring(buffer, side), outbound = ring(buffer, side === 0 ? 1 : 0);
  let reserved = false;
  function reserve(text: string) {
    if (reserved) return null;
    const bytes = encoder.encode(text);
    const need = frameHeaderBytes + align(bytes.byteLength);
    if (need > ringBytes) throw new DOMException(`Message exceeds the ${ringBytes - frameHeaderBytes} byte limit between processes`, "DataCloneError");
    const written = atomicLoad(outbound.header, writeIndex) >>> 0;
    if (need > ringBytes - ((written - (atomicLoad(outbound.header, readIndex) >>> 0)) >>> 0)) return null;
    outbound.view.setUint32(written % ringBytes, bytes.byteLength, true);
    outbound.copyIn(bytes, (written + frameHeaderBytes) >>> 0);
    reserved = true;
    let prepared = true;
    return {
      commit() {
        if (!prepared) return;
        prepared = false; reserved = false;
        atomicStore(outbound.header, writeIndex, (written + need) | 0);
        atomicAdd(outbound.header, signalIndex, 1); atomicNotify(outbound.header, signalIndex);
      },
      abort() { if (prepared) { prepared = false; reserved = false; } },
    };
  }
  function drain(consume: (text: string) => void) {
    let count = 0;
    for (;;) {
      const read = atomicLoad(inbound.header, readIndex) >>> 0, available = (atomicLoad(inbound.header, writeIndex) - read) >>> 0;
      if (!available) return count;
      const length = inbound.view.getUint32(read % ringBytes, true), need = frameHeaderBytes + align(length);
      if (available > ringBytes || need > available) throw new DOMException("Invalid shared lane frame", "DataCloneError");
      const text = decoder.decode(inbound.copyOut((read + frameHeaderBytes) >>> 0, length));
      atomicStore(inbound.header, readIndex, (read + need) | 0);
      consume(text); count++;
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
  return { buffer, reserve, drain, watch };
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
