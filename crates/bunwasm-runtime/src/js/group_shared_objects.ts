// SharedArrayBuffer transfer between processes of one memory group (shared-group QuickJS).
// A backing is a group region at the same address in every member, so a received buffer is
// a new object over the sender's bytes, not a copy. The sender pins each region for the
// message and routes the pin to the receiving process; the receiver accepts it. Only a
// Worker's own process is a known destination today (Worker.postMessage and workerData);
// other directions keep the DataCloneError of processes outside a group.
(function (internal: BunWasm.Internal): BunWasm.SharedObjects {
  "use strict";
  const native = internal.native as unknown as BunWasm.GroupSharedNatives;
  const growable = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "growable")?.get;
  const byteLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!;
  const cloneError = (message: string) => new DOMException(message, "DataCloneError");
  // One decode reads each reference twice (hydrate, then the graph walk); a pin is accepted once.
  const received = new Map<string, SharedArrayBuffer>();

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
        if (destination === undefined) throw cloneError("A SharedArrayBuffer can only be posted to a Worker started by this process");
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

  return { begin, read, wait: () => null };
})
