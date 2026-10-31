const atomicLoad = Atomics.load, atomicStore = Atomics.store, atomicAdd = Atomics.add;
const atomicNotify = Atomics.notify, atomicCompareExchange = Atomics.compareExchange, atomicWaitAsync = Atomics.waitAsync;
const sharedMailboxSlotCount = 8;
const sharedMailboxSlotBytes = 8 * 1024;
const headerWords = 4;
const slotHeaderBytes = Int32Array.BYTES_PER_ELEMENT;
const payloadBytes = sharedMailboxSlotBytes - slotHeaderBytes;
const writeIndex = 0;
const readIndex = 1;
const closedIndex = 2;
const signalIndex = 3;
const consumedFlag = 0x80000000;
const byteOffset = headerWords * Int32Array.BYTES_PER_ELEMENT;

export interface SharedMailbox {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  readonly maxFrameBytes: number;
  reserve(bytes: Uint8Array): { commit(): void; abort(): void } | null;
  write(bytes: Uint8Array): boolean;
  drain(consume: (bytes: Uint8Array, cursor: number) => void | boolean): number;
  sweep(consume: (bytes: Uint8Array, cursor: number) => boolean): number;
  watch(ready: () => void): () => void;
  wake(): void;
  close(): void;
  inspect(): { queued: number; closed: boolean };
}

function cursor(value: number) { return value >>> 0; }
function distance(written: number, read: number) { return (written - read) >>> 0; }
export function requireSharedMailboxWake() {
  if (typeof atomicWaitAsync !== "function") throw new Error("Shared mailbox requires host Atomics.waitAsync");
}

export function createSharedMailbox(buffer = new SharedArrayBuffer(byteOffset + sharedMailboxSlotCount * sharedMailboxSlotBytes)): SharedMailbox {
  if (buffer.byteLength !== byteOffset + sharedMailboxSlotCount * sharedMailboxSlotBytes) throw new Error("Invalid shared mailbox size");
  const header = new Int32Array(buffer, 0, headerWords);
  const bytes = new Uint8Array(buffer);
  let reserved = false;
  function signal() { atomicAdd(header, signalIndex, 1); atomicNotify(header, signalIndex); }
  function watch(ready: () => void) {
    let active = true;
    function changed() {
      if (!active || atomicLoad(header, closedIndex)) return;
      const observed = atomicLoad(header, signalIndex);
      ready(); arm(observed);
    }
    function arm(observed: number) {
      if (!active || atomicLoad(header, closedIndex)) return;
      const waiting = atomicWaitAsync(header, signalIndex, observed);
      if (waiting.async) void waiting.value.then(changed);
      else queueMicrotask(changed);
    }
    arm(atomicLoad(header, signalIndex));
    return () => { if (!active) return; active = false; signal(); };
  }
  function queued() {
    if (atomicLoad(header, closedIndex) !== 0) return 0;
    return distance(cursor(atomicLoad(header, writeIndex)), cursor(atomicLoad(header, readIndex)));
  }
  function reserve(value: Uint8Array) {
    if (reserved || value.byteLength > payloadBytes || atomicLoad(header, closedIndex) !== 0) return null;
    const written = cursor(atomicLoad(header, writeIndex));
    const read = cursor(atomicLoad(header, readIndex));
    if (distance(written, read) >= sharedMailboxSlotCount) return null;
    const slot = byteOffset + (written % sharedMailboxSlotCount) * sharedMailboxSlotBytes;
    new DataView(buffer, slot, slotHeaderBytes).setUint32(0, value.byteLength, true);
    bytes.set(value, slot + slotHeaderBytes);
    reserved = true;
    let prepared = true;
    return {
      commit() {
        if (!prepared) return;
        prepared = false; reserved = false;
        if (atomicLoad(header, closedIndex) !== 0) return;
        atomicStore(header, writeIndex, (written + 1) | 0);
        atomicNotify(header, writeIndex);
        signal();
      },
      abort() { if (!prepared) return; prepared = false; reserved = false; },
    };
  }
  function write(value: Uint8Array) {
    const reservation = reserve(value);
    if (!reservation) return false;
    reservation.commit(); return true;
  }
  function advance(read: number) {
    atomicCompareExchange(header, readIndex, read | 0, (read + 1) | 0);
    atomicNotify(header, readIndex);
    signal();
  }
  function frame(read: number) {
    const slot = byteOffset + (read % sharedMailboxSlotCount) * sharedMailboxSlotBytes;
    const view = new DataView(buffer, slot, slotHeaderBytes), stored = view.getUint32(0, true);
    const length = stored & ~consumedFlag;
    if (length > payloadBytes) { close(); throw new Error("Invalid shared mailbox frame"); }
    return { view, length, consumed: (stored & consumedFlag) !== 0, bytes: bytes.slice(slot + slotHeaderBytes, slot + slotHeaderBytes + length) };
  }
  function sweep(consume: (value: Uint8Array, cursor: number) => boolean) {
    if (atomicLoad(header, closedIndex) !== 0) return 0;
    if (queued() > sharedMailboxSlotCount) { close(); throw new Error("Invalid shared mailbox cursors"); }
    const read = cursor(atomicLoad(header, readIndex)), written = cursor(atomicLoad(header, writeIndex));
    let count = 0;
    for (let next = read; next !== written; next = cursor(next + 1)) {
      if (consumeSwept(next, consume)) count++;
    }
    return count;
  }
  function consumeSwept(read: number, consume: (value: Uint8Array, cursor: number) => boolean) {
    const value = frame(read);
    if (value.consumed) return false;
    try {
      if (!consume(value.bytes, read)) return false;
      value.view.setUint32(0, (value.length | consumedFlag) >>> 0, true); return true;
    } catch (error) { close(); throw error; }
  }
  function drain(consume: (value: Uint8Array, cursor: number) => void | boolean) {
    let count = 0;
    for (;;) {
      if (atomicLoad(header, closedIndex) !== 0) return count;
      const read = cursor(atomicLoad(header, readIndex));
      if (read === cursor(atomicLoad(header, writeIndex))) return count;
      if (queued() > sharedMailboxSlotCount) { close(); throw new Error("Invalid shared mailbox cursors"); }
      const value = frame(read);
      try { if (!value.consumed && consume(value.bytes, read) === false) return count; }
      catch (error) { close(); throw error; }
      advance(read);
      count++;
    }
  }
  function close() {
    atomicStore(header, closedIndex, 1);
    atomicStore(header, readIndex, atomicLoad(header, writeIndex));
    atomicNotify(header, writeIndex);
    atomicNotify(header, readIndex);
    signal();
  }
  return { buffer, capacity: sharedMailboxSlotCount, maxFrameBytes: payloadBytes, reserve, write, drain, sweep, watch, wake: signal, close, inspect: () => ({ queued: queued(), closed: atomicLoad(header, closedIndex) !== 0 }) };
}
