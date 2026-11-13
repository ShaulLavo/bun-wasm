// Group lanes for shared-group engines: MessagePort frames between guests of one memory group,
// stored in group memory by the runtime core (crates/bunwasm-runtime/src/wasm/lane.rs). A frame
// committed by postMessage is complete in the destination's lane before postMessage returns, and
// draining it calls no host import. See docs/worker-threads.md, "Group lanes".
//
// Every native here that changes group memory is a word native: numbers in, one number out, and
// the native bridge cannot fail its call or its return. `laneReserve` and `laneDrain` carry text,
// so they can throw after their effect; a word native (`laneAbort`, `laneDrained`) then settles
// what they left.
(function (internal: BunWasm.Internal): BunWasm.GroupLanes {
  "use strict";
  const native = internal.native.wasm;
  /** The closed end state in lane.rs. */
  const CLOSED = 3;
  const DRAIN_LIMIT = 1024;
  /** A refusable word native's refused result. */
  const REFUSED = -1;
  /** A word result holding a pair keeps its second number, a generation, in the low 28 bits. */
  const PAIR = 2 ** 28;
  let ledger = 0;
  function cloneError(error: unknown) {
    return new DOMException(error instanceof Error ? error.message : String(error), "DataCloneError");
  }
  function refusing<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) { throw cloneError(error); }
  }
  /** The value of a refusable word native, or its refusal as a DataCloneError. */
  function accepted(result: number) {
    if (result !== REFUSED) return result;
    throw cloneError(refusing(() => native.laneRefusal()));
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
  // An end reads `ref` at each call: `create` fills it in after both ends were opened over it.
  function open(ref: BunWasm.GroupLaneRef, side: 0 | 1): BunWasm.GroupSharedLane {
    return {
      ref, side,
      reserve(text) {
        // The frame is staged under this end, not under an id the reply carries: a reply lost
        // after staging leaves a frame the abort below still finds.
        try { native.laneReserve(ref.slot, ref.generation, side, text); }
        catch (error) {
          native.laneAbort(ref.slot, ref.generation, side);
          throw cloneError(error);
        }
        let settled = false;
        return {
          commit() {
            if (settled) return false;
            settled = true;
            return native.laneCommit(ref.slot, ref.generation, side) === 1;
          },
          abort() {
            if (settled) return;
            settled = true;
            native.laneAbort(ref.slot, ref.generation, side);
          },
        };
      },
      drain(limit = DRAIN_LIMIT) {
        // The core keeps the frames it read until told this thread has them, so a call that
        // throws on its way back returns the same frames next time.
        const [frames, more, terminal] = native.laneDrain(ref.slot, ref.generation, side, limit);
        if (frames.length) native.laneDrained(ref.slot, ref.generation, side);
        return { frames, more, terminal };
      },
      closeRead() { native.laneCloseRead(ref.slot, ref.generation, side); },
      closeEnd() { return native.laneCloseEnd(ref.slot, ref.generation, side) === 1; },
      peerClosed() { return native.lanePeerClosed(ref.slot, ref.generation, side) === 1; },
      transferEpoch() { return accepted(native.laneTransferEpoch(ref.slot, ref.generation, side)); },
      transfer(custody) {
        const [kind, first, second, third] = custodyArguments(custody);
        native.laneTransfer(ref.slot, ref.generation, side, kind, first, second, third);
      },
      // A staged post: the frame and the ends it carries stay under this end until the engine's
      // transfer native commits them, or `abort` drops them. Nothing moves before that commit.
      stage(text) {
        try { native.laneReserve(ref.slot, ref.generation, side, text); }
        catch (error) {
          native.laneAbort(ref.slot, ref.generation, side);
          throw cloneError(error);
        }
      },
      stageEnd(carried) { return accepted(native.laneStageEnd(ref.slot, ref.generation, side, carried.slot, carried.generation, carried.side)); },
      abort() { native.laneAbort(ref.slot, ref.generation, side); },
    };
  }
  /** The last staged commit of this thread: its nonce, and whether its reader was due a wake. */
  function committed(): [nonce: number, wake: boolean] {
    if (!ledger) return [0, false];
    const word = native.laneCommitted();
    const wake = word % 2;
    return [(word - wake) / 2, wake === 1];
  }
  // The ledger keeps what `laneCreate`, `laneCell` and `laneAdopt` did whether or not this thread
  // can then remember it. So each is the last thing that can fail: what holds its result is
  // made first, and after the native there are only stores. A lane, a cell or an end taken with
  // nothing left to refer to it would stay in the ledger for good.
  function adopt(lane: BunWasm.GroupPortLane, version: number) {
    return ledger !== 0 && native.laneAdopt(lane.slot, lane.generation, lane.side, lane.epoch, version) === 1;
  }
  return {
    ledger: ensureLedger,
    join(address, cell) {
      const registered = native.laneJoin(address, cell[0], cell[1]);
      ledger = address;
      return registered;
    },
    create(ref) {
      ensureLedger();
      const word = native.laneCreate();
      if (word === REFUSED) throw cloneError(refusing(() => native.laneRefusal()));
      ref.generation = word % PAIR;
      ref.slot = (word - ref.generation) / PAIR;
    },
    open,
    adopt,
    discard(lane, version) {
      // The end is still in flight, or a port that was never finished took it and left it
      // open. Taking it does nothing in the second case, and neither close does anything to
      // an end that is not this thread's and open, so every step can be repeated.
      const io = open({ slot: lane.slot, generation: lane.generation }, lane.side);
      adopt(lane, version);
      io.closeRead();
      io.closeEnd();
    },
    cell() {
      ensureLedger();
      const cell: BunWasm.LaneCell = [0, 0];
      const word = native.laneCell();
      if (word === REFUSED) throw cloneError(refusing(() => native.laneRefusal()));
      cell[1] = word % PAIR;
      cell[0] = (word - cell[1]) / PAIR;
      return cell;
    },
    exited(cell) { if (ledger) native.laneExited(cell[0], cell[1]); },
    sweep(full) { if (ledger) native.laneSweep(full); },
    end(ref, side) {
      if (!ledger) return [CLOSED, 0];
      const result = native.laneEnd(ref.slot, ref.generation, side);
      const state = result % 16;
      return [state, (result - state) / 16];
    },
    sever(ref, side) { if (ledger) native.laneSever(ref.slot, ref.generation, side); },
    census() { return native.laneCensus(); },
    epochs() { return ledger ? native.laneEpochs() : 0; },
    committed,
  };
})
