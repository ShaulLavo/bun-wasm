const sharedMailboxSlotCount = 8;
const sharedMailboxSlotBytes = 8 * 1024;
const headerWords = 4;
const slotHeaderBytes = Int32Array.BYTES_PER_ELEMENT;
const payloadBytes = sharedMailboxSlotBytes - slotHeaderBytes;
const writeIndex = 0;
const readIndex = 1;
const closedIndex = 2;
const byteOffset = headerWords * Int32Array.BYTES_PER_ELEMENT;

export interface SharedMailbox {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  reserve(bytes: Uint8Array): { commit(): void; abort(): void } | null;
  write(bytes: Uint8Array): boolean;
  drain(consume: (bytes: Uint8Array) => void | boolean): number;
  close(): void;
  inspect(): { queued: number; closed: boolean };
}

function cursor(value: number) { return value >>> 0; }
function distance(written: number, read: number) { return (written - read) >>> 0; }

export function createSharedMailbox(buffer = new SharedArrayBuffer(byteOffset + sharedMailboxSlotCount * sharedMailboxSlotBytes)): SharedMailbox {
  if (buffer.byteLength !== byteOffset + sharedMailboxSlotCount * sharedMailboxSlotBytes) throw new Error("Invalid shared mailbox size");
  const header = new Int32Array(buffer, 0, headerWords);
  const bytes = new Uint8Array(buffer);
  let reserved = false;
  function queued() {
    if (Atomics.load(header, closedIndex) !== 0) return 0;
    return distance(cursor(Atomics.load(header, writeIndex)), cursor(Atomics.load(header, readIndex)));
  }
  function reserve(value: Uint8Array) {
    if (reserved || value.byteLength > payloadBytes || Atomics.load(header, closedIndex) !== 0) return null;
    const written = cursor(Atomics.load(header, writeIndex));
    const read = cursor(Atomics.load(header, readIndex));
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
        if (Atomics.load(header, closedIndex) !== 0) return;
        Atomics.store(header, writeIndex, (written + 1) | 0);
        Atomics.notify(header, writeIndex);
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
    Atomics.compareExchange(header, readIndex, read | 0, (read + 1) | 0);
    Atomics.notify(header, readIndex);
  }
  function drain(consume: (value: Uint8Array) => void | boolean) {
    let count = 0;
    for (;;) {
      if (Atomics.load(header, closedIndex) !== 0) return count;
      const read = cursor(Atomics.load(header, readIndex));
      if (read === cursor(Atomics.load(header, writeIndex))) return count;
      if (queued() > sharedMailboxSlotCount) { close(); throw new Error("Invalid shared mailbox cursors"); }
      const slot = byteOffset + (read % sharedMailboxSlotCount) * sharedMailboxSlotBytes;
      const length = new DataView(buffer, slot, slotHeaderBytes).getUint32(0, true);
      if (length > payloadBytes) { close(); throw new Error("Invalid shared mailbox frame"); }
      const value = bytes.slice(slot + slotHeaderBytes, slot + slotHeaderBytes + length);
      try { if (consume(value) === false) return count; }
      catch (error) { close(); throw error; }
      advance(read);
      count++;
    }
  }
  function close() {
    Atomics.store(header, closedIndex, 1);
    Atomics.store(header, readIndex, Atomics.load(header, writeIndex));
    Atomics.notify(header, writeIndex);
    Atomics.notify(header, readIndex);
  }
  return { buffer, capacity: sharedMailboxSlotCount, reserve, write, drain, close, inspect: () => ({ queued: queued(), closed: Atomics.load(header, closedIndex) !== 0 }) };
}
