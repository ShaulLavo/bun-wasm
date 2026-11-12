// Group lanes for shared-group engines: MessagePort frames between guests of one memory group,
// stored in group memory by the runtime core (crates/bunwasm-runtime/src/wasm/lane.rs). A frame
// committed by postMessage is complete in the destination's lane before postMessage returns, and
// draining it calls no host import. See docs/worker-threads.md, "Group lanes".
(function (internal: BunWasm.Internal): BunWasm.GroupLanes {
  "use strict";
  const native = internal.native.wasm;
  /** The closed end state in lane.rs. */
  const CLOSED = 3;
  const DRAIN_LIMIT = 1024;
  let ledger = 0;
  function cloneError(error: unknown) {
    return new DOMException(error instanceof Error ? error.message : String(error), "DataCloneError");
  }
  function refusing<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) { throw cloneError(error); }
  }
  function ensureLedger() {
    if (!ledger) ledger = refusing(() => native.laneLedger());
    return ledger;
  }
  function custodyArguments(custody: BunWasm.LaneCustody): [number, number, number, number] {
    if (custody.kind === "lane") return [0, custody.lane.slot, custody.lane.generation, custody.side];
    if (custody.kind === "cell") return [1, custody.cell[0], custody.cell[1], 0];
    return [2, 0, 0, 0];
  }
  function open(ref: BunWasm.GroupLaneRef, side: 0 | 1): BunWasm.GroupSharedLane {
    const { slot, generation } = ref;
    return {
      ref, side,
      reserve(text) {
        const id = refusing(() => native.laneReserve(slot, generation, side, text));
        let settled = false;
        return {
          commit() {
            if (settled) return false;
            settled = true;
            return native.laneCommit(id);
          },
          abort() {
            if (settled) return;
            settled = true;
            native.laneAbort(id);
          },
        };
      },
      drain(limit = DRAIN_LIMIT) {
        const [frames, more, terminal] = native.laneDrain(slot, generation, side, limit);
        return { frames, more, terminal };
      },
      closeRead() { native.laneCloseRead(slot, generation, side); },
      closeEnd() { return native.laneCloseEnd(slot, generation, side); },
      peerClosed() { return native.lanePeerClosed(slot, generation, side); },
      transferEpoch() { return refusing(() => native.laneTransferEpoch(slot, generation, side)); },
      transfer(custody) {
        const [kind, first, second, third] = custodyArguments(custody);
        native.laneTransfer(slot, generation, side, kind, first, second, third);
      },
    };
  }
  function adopt(lane: BunWasm.GroupPortLane, version: number) {
    if (!ledger) return null;
    const ref = { slot: lane.slot, generation: lane.generation };
    return native.laneAdopt(lane.slot, lane.generation, lane.side, lane.epoch, version) ? open(ref, lane.side) : null;
  }
  return {
    ledger: ensureLedger,
    join(address, cell) {
      const registered = native.laneJoin(address, cell[0], cell[1]);
      ledger = address;
      return registered;
    },
    create() {
      ensureLedger();
      const [slot, generation] = refusing(() => native.laneCreate());
      return { slot, generation };
    },
    open,
    adopt,
    discard(lane, version) {
      const io = adopt(lane, version);
      if (!io) return;
      io.closeRead();
      io.closeEnd();
    },
    cell() {
      ensureLedger();
      return refusing(() => native.laneCell());
    },
    exited(cell) { if (ledger) native.laneExited(cell[0], cell[1]); },
    sweep(full) { if (ledger) native.laneSweep(full); },
    end(ref, side) { return ledger ? native.laneEnd(ref.slot, ref.generation, side) : [CLOSED, 0]; },
    sever(ref, side) { if (ledger) native.laneSever(ref.slot, ref.generation, side); },
    census() { return native.laneCensus(); },
  };
})
