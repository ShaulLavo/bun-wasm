// SharedArrayBuffer transfer between processes of one memory group (shared-group QuickJS).
// A backing is a group region at the same address in every member, so a received buffer is
// a new object over the sender's bytes, not a copy. The sender pins each region for the
// message and routes the pin to the receiving process; the receiver accepts it. Only a
// Worker's own process and a worker's parent are known destinations (worker_threads); other
// directions keep the DataCloneError of processes outside a group.
//
// MessagePort lanes are the browser's shared rings (`shared_lane`, from web/src/shared-objects/
// lane.ts) over group buffers. A reply committed to a lane before Atomics.notify is complete when
// the waiter wakes, whatever the control pipe holds. Without Atomics.waitAsync, a lane's watch is
// a host FUTEX watch: the event loop sleeps on it as poll kind 7 (`subscriptions`) and re-arms
// the ones that fired (`poll`).
(function (internal: BunWasm.Internal): BunWasm.SharedObjects {
  "use strict";
  const native = internal.native as unknown as BunWasm.GroupSharedNatives;
  const growable = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "growable")?.get;
  const byteLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!;
  const cloneError = (message: string) => new DOMException(message, "DataCloneError");
  // One decode reads each reference twice (hydrate, then the graph walk); a pin is accepted once.
  const received = new Map<string, SharedArrayBuffer>();
  const FUTEX = 7;
  const lane = internal.require("shared_lane");
  // Armed FUTEX watches by host watch id; each fires `changed` at most once.
  const watches = new Map<number, () => void>();

  function begin(): BunWasm.SharedPublication {
    const pins: number[] = [];
    let routed = 0;
    return {
      reference(buffer) {
        // Each member keeps its own length for a buffer, so a growable one cannot stay coherent.
        if (growable?.call(buffer)) throw cloneError("A growable SharedArrayBuffer cannot be shared between processes");
        pins.push(native.shmPin(buffer));
        return { id: `g/${pins[pins.length - 1]}`, byteLength: byteLength.call(buffer) };
      },
      publish(destination) {
        if (destination === undefined) throw cloneError("A SharedArrayBuffer can only be posted to a Worker or the parent of this process");
        for (; routed < pins.length; routed++) native.shmRoute(pins[routed]!, destination);
      },
      // A routed pin belongs to its destination, which releases it when it accepts or exits.
      abort() {
        for (const pin of pins.slice(routed)) native.shmUnpin(pin);
        routed = pins.length;
      },
    };
  }

  function read(reference: BunWasm.SharedReference): SharedArrayBuffer {
    const known = received.get(reference.id);
    if (known) return known;
    const pin = /^g\/(\d+)$/.exec(reference.id);
    if (!pin) throw cloneError("Invalid shared reference");
    const buffer = native.shmAccept(Number(pin[1]), reference.byteLength);
    if (!received.size) queueMicrotask(() => received.clear());
    received.set(reference.id, buffer);
    return buffer;
  }

  /**
   * A message that is never decoded (its port closed first) gives back its pins. A pin it already
   * accepted, or one never routed here, is not this member's to unpin.
   */
  function discard(references: readonly BunWasm.SharedReference[]) {
    for (const reference of references) {
      const pin = /^g\/(\d+)$/.exec(reference.id);
      if (!pin || received.has(reference.id)) continue;
      try { native.shmUnpin(Number(pin[1])); }
      catch { /* accepted earlier, or owned elsewhere */ }
    }
  }

  /** shared_lane's waiter: a FUTEX watch the event loop polls (kind 7) instead of Atomics.waitAsync. */
  function futexWait(header: Int32Array, index: number, observed: number, changed: () => void) {
    const id = native.futexWatch(header.buffer as SharedArrayBuffer, header.byteOffset + index * 4, observed);
    watches.set(id, changed);
    return () => { if (watches.delete(id)) native.futexUnwatch(id); };
  }
  function subscriptions(): Uint8Array {
    const bytes = new Uint8Array(watches.size * 16), view = new DataView(bytes.buffer);
    let offset = 0;
    for (const id of watches.keys()) {
      view.setUint32(offset, FUTEX, true); view.setUint32(offset + 4, id, true); view.setUint32(offset + 8, id, true);
      offset += 16;
    }
    return bytes;
  }
  /** Re-arms every watch that fired: a hit stays ready until unwatched, so the loop must not keep it. */
  function poll() {
    if (!watches.size) return false;
    const events = internal.native.procPoll(subscriptions(), 0);
    if (typeof events === "number") throw new Error(`Shared lane poll failed (errno ${-events})`);
    const view = new DataView(events.buffer, events.byteOffset, events.byteLength);
    for (let offset = 0; offset < events.byteLength; offset += 16) {
      const id = view.getUint32(offset, true), changed = watches.get(id);
      if (!changed) continue;
      watches.delete(id); native.futexUnwatch(id);
      changed();
    }
    return events.byteLength > 0;
  }
  const lanes = {
    create: () => lane.createSharedLaneBuffer(),
    open: (buffer: SharedArrayBuffer, side: 0 | 1) => lane.openSharedLane(buffer, side, futexWait),
    subscriptions, poll,
  };

  return { begin, read, discard, wait: () => null, lanes };
})
