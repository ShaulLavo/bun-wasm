export const sharedMailboxSlotCount = 8;
export const sharedMailboxSlotBytes = 8 * 1024;
const headerWords = 4;
const slotHeaderBytes = Int32Array.BYTES_PER_ELEMENT;
const payloadBytes = sharedMailboxSlotBytes - slotHeaderBytes;
const writeIndex = 0;
const readIndex = 1;
const closedIndex = 2;
const byteOffset = headerWords * Int32Array.BYTES_PER_ELEMENT;

export interface SharedMailbox {
  readonly buffer: SharedArrayBuffer;
  write(bytes: Uint8Array): boolean;
  drain(consume: (bytes: Uint8Array) => void): number;
  close(): void;
  inspect(): { queued: number; closed: boolean };
}

export function createSharedMailbox(buffer = new SharedArrayBuffer(byteOffset + sharedMailboxSlotCount * sharedMailboxSlotBytes)): SharedMailbox {
  const header = new Int32Array(buffer, 0, headerWords);
  const bytes = new Uint8Array(buffer);
  function queued() { return Atomics.load(header, writeIndex) - Atomics.load(header, readIndex); }
  function write(value: Uint8Array) {
    if (value.byteLength > payloadBytes || Atomics.load(header, closedIndex) !== 0) return false;
    const written = Atomics.load(header, writeIndex);
    const read = Atomics.load(header, readIndex);
    if (written - read >= sharedMailboxSlotCount) return false;
    const slot = byteOffset + (written % sharedMailboxSlotCount) * sharedMailboxSlotBytes;
    new DataView(buffer, slot, slotHeaderBytes).setUint32(0, value.byteLength, true);
    bytes.set(value, slot + slotHeaderBytes);
    Atomics.store(header, writeIndex, written + 1);
    Atomics.notify(header, writeIndex);
    return true;
  }
  function drain(consume: (value: Uint8Array) => void) {
    let count = 0;
    for (;;) {
      const read = Atomics.load(header, readIndex);
      if (read >= Atomics.load(header, writeIndex)) return count;
      const slot = byteOffset + (read % sharedMailboxSlotCount) * sharedMailboxSlotBytes;
      const length = new DataView(buffer, slot, slotHeaderBytes).getUint32(0, true);
      if (length > payloadBytes) throw new Error("Invalid shared mailbox frame");
      consume(bytes.slice(slot + slotHeaderBytes, slot + slotHeaderBytes + length));
      Atomics.store(header, readIndex, read + 1);
      Atomics.notify(header, readIndex);
      count++;
    }
  }
  function close() {
    Atomics.store(header, closedIndex, 1);
    Atomics.notify(header, writeIndex);
    Atomics.notify(header, readIndex);
  }
  return { buffer, write, drain, close, inspect: () => ({ queued: queued(), closed: Atomics.load(header, closedIndex) !== 0 }) };
}
