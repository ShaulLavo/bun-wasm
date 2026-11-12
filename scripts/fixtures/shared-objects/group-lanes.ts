// A codec and topology control for the shared-group lane protocol: the lane natives' contract
// over plain arrays, shared by several source runtimes in one process, under the runtime's real
// `worker_lane.ts`. It is not the lane algorithm; crates/bunwasm-runtime/src/wasm/lane.rs and its
// unit tests own ring, spill, ledger and lifetime behavior. This model keeps only what the runtime
// JavaScript depends on: ownership by end, in-flight epochs and custody, reader-closed, terminal,
// armed, refusal before staging, and which natives can fail on their way to or from the core.
import "../../../crates/bunwasm-runtime/src/js/worker_protocol.d.ts";
import "../../../crates/bunwasm-runtime/src/js/webassembly_types.d.ts";
import { sourceLanes } from "./source-runtime";

type End = { state: "open" | "in-flight" | "closed"; owner: number; epoch: number; version: number; custody: BunWasm.LaneCustody | null };
type Direction = { frames: string[]; readerClosed: boolean; armed: boolean; severed: boolean };
type Lane = { ends: [End, End]; directions: [Direction, Direction] };
type Side = 0 | 1;
/** One native of the allocating bridge failing once: before it runs, or after it ran and before its reply arrives. */
type Fault = { native: "laneReserve" | "laneDrain" | "laneRefusal"; when: "before" | "after" };
type LaneNatives = Pick<BunWasm.WasmNative, Extract<keyof BunWasm.WasmNative, `lane${string}`>>;
const STATES = { open: 1, "in-flight": 2, closed: 3 } as const;
const PAIR = 2 ** 28;
const UNDELIVERED = "MessagePort lane holds received messages this thread has not taken";

export function createGroupLaneModel() {
  const lanes: Lane[] = [];
  const cells: ({ tag: number; open: boolean } | null)[] = [];
  /**
   * `sweeps` records each sweep request by member tag, so tests can see where housekeeping runs.
   * `staged` counts frames staged and not yet committed or aborted, across all members.
   * `calls` names every lane native in the order the runtimes called them.
   */
  const control = { refuse: false, reserved: 0, drained: 0, staged: 0, fault: null as Fault | null, calls: [] as string[], sweeps: [] as { tag: number; full: boolean }[] };
  function lane(ref: BunWasm.GroupLaneRef) {
    const found = lanes[ref.slot];
    if (!found || ref.generation !== 1) throw new Error("Unknown lane");
    return found;
  }
  function custodyClosed(custody: BunWasm.LaneCustody | null) {
    if (custody?.kind === "lane") return lane(custody.lane).directions[custody.side].readerClosed;
    if (custody?.kind === "cell") return !cells[custody.cell[0]]?.open;
    return false;
  }
  function closeOrphan(item: Lane, side: Side) {
    const end = item.ends[side];
    if (end.state !== "in-flight" || !custodyClosed(end.custody)) return false;
    Object.assign(end, { state: "closed", epoch: end.epoch + 1 });
    item.directions[side].readerClosed = true;
    return true;
  }
  function cascade() {
    let changed = true;
    while (changed) changed = lanes.map(item => closeOrphan(item, 0) || closeOrphan(item, 1)).some(Boolean);
  }
  /** What the core does for one member, with no bridge in front of it. */
  function core(tag: number) {
    /** Closing an end that is no longer this member's is a no-op, as in lane.rs. */
    function owns(ref: BunWasm.GroupLaneRef, side: Side) {
      const end = lane(ref).ends[side];
      return end.state === "open" && end.owner === tag;
    }
    function owned(ref: BunWasm.GroupLaneRef, side: Side) {
      const found = lane(ref), end = found.ends[side];
      if (end.state !== "open" || end.owner !== tag) throw new Error(`Lane end ${ref.slot}/${side} is not owned by ${tag}`);
      return { found, end };
    }
    function open(ref: BunWasm.GroupLaneRef, side: Side): BunWasm.GroupSharedLane {
      return {
        ref, side,
        reserve(text) {
          const { found } = owned(ref, side);
          if (control.refuse) throw new Error("MessagePort lane storage was refused (errno 48)");
          const direction = found.directions[side === 0 ? 1 : 0];
          if (direction.readerClosed) return { commit: () => false, abort() {} };
          control.reserved++; control.staged++;
          let settled = false;
          const settle = () => { if (!settled) control.staged--; settled = true; };
          return {
            commit() {
              if (settled) return false;
              settle(); direction.frames.push(text);
              const wake = direction.armed; direction.armed = false; return wake;
            },
            abort: settle,
          };
        },
        drain(limit) {
          const { found } = owned(ref, side);
          const direction = found.directions[side];
          const frames = direction.frames.splice(0, limit);
          control.drained += frames.length;
          const more = direction.frames.length > 0;
          if (!frames.length) direction.armed = true;
          const writer = found.ends[side === 0 ? 1 : 0];
          return { frames, more, terminal: !more && (writer.state === "closed" || direction.severed) };
        },
        closeRead() {
          if (!owns(ref, side)) return;
          const { found } = owned(ref, side);
          found.directions[side].readerClosed = true; found.directions[side].frames.length = 0; cascade();
        },
        closeEnd() {
          if (!owns(ref, side)) return false;
          const { found, end } = owned(ref, side);
          found.directions[side].readerClosed = true; cascade();
          Object.assign(end, { state: "closed", owner: 0, epoch: end.epoch + 1 });
          const peer = found.directions[side === 0 ? 1 : 0];
          const wake = peer.armed; peer.armed = false; return wake;
        },
        peerClosed() { return lane(ref).directions[side === 0 ? 1 : 0].readerClosed; },
        transferEpoch() { return owned(ref, side).end.epoch + 1; },
        transfer(custody) {
          const { end } = owned(ref, side);
          Object.assign(end, { state: "in-flight", owner: 0, epoch: end.epoch + 1, custody });
          if (custodyClosed(custody)) cascade();
        },
      };
    }
    function adopt(port: BunWasm.GroupPortLane, version: number) {
      const end = lane(port).ends[port.side];
      if (end.state !== "in-flight" || end.epoch !== port.epoch) return false;
      Object.assign(end, { state: "open", owner: tag, epoch: end.epoch + 1, version, custody: null });
      return true;
    }
    return {
      open, adopt,
      join(cell: BunWasm.LaneCell) { const found = cells[cell[0]]; if (!found?.open) return false; found.tag = tag; return true; },
      create(): BunWasm.GroupLaneRef {
        const end = (): End => ({ state: "open", owner: tag, epoch: 1, version: 0, custody: null });
        const direction = (): Direction => ({ frames: [], readerClosed: false, armed: false, severed: false });
        lanes.push({ ends: [end(), end()], directions: [direction(), direction()] });
        return { slot: lanes.length - 1, generation: 1 };
      },
      cell(): BunWasm.LaneCell { cells.push({ tag, open: true }); return [cells.length - 1, 1]; },
      exited(cell: BunWasm.LaneCell) {
        const found = cells[cell[0]];
        if (!found?.open) return;
        found.open = false;
        for (const item of lanes) for (const side of [0, 1] as const) {
          const end = item.ends[side];
          if (end.state !== "open" || end.owner !== found.tag || found.tag === tag) continue;
          // The model releases at once what lane.rs declares dead and releases after the host.
          Object.assign(end, { state: "closed", owner: 0, epoch: end.epoch + 1 });
          item.directions[side].readerClosed = true;
        }
        cascade();
      },
      end(ref: BunWasm.GroupLaneRef, side: Side) { const end = lane(ref).ends[side]; return STATES[end.state] + end.version * 16; },
      sever(ref: BunWasm.GroupLaneRef, side: Side) { lane(ref).directions[side === 0 ? 1 : 0].severed = true; },
    };
  }
  /** Every end's epoch, summed: all the root has to compare, with no counter beside the ends. */
  function epochs() {
    return lanes.reduce((sum, item) => sum + item.ends[0].epoch + item.ends[1].epoch, 0);
  }
  /**
   * The lane natives of one member. Word natives return numbers and never throw. `laneReserve`,
   * `laneDrain` and `laneRefusal` cross the allocating bridge, where `control.fault` makes one
   * call throw; what they changed stays under the end's name for a word native to settle.
   */
  function natives(tag: number): LaneNatives {
    const member = core(tag);
    const staged = new Map<string, BunWasm.GroupLaneFrame>();
    const received = new Map<string, BunWasm.GroupLaneDrain>();
    let refusal = "MessagePort lanes are not initialized in this thread";
    const key = (slot: number, generation: number, side: number) => `${slot}/${generation}/${side}`;
    const end = (slot: number, generation: number, side: number) => member.open({ slot, generation }, side === 1 ? 1 : 0);
    /** A reply is only lost with something in it: `changed` says whether this call left an effect. */
    function bridged<T>(name: Fault["native"], operation: () => T, changed: (result: T) => boolean = () => true): T {
      const fault = control.fault?.native === name ? control.fault : null;
      if (fault?.when === "before") { control.fault = null; throw new Error("core data allocation failed"); }
      const result = operation();
      if (fault?.when === "after" && changed(result)) { control.fault = null; throw new Error("core data allocation failed"); }
      return result;
    }
    function refusable(operation: () => number) {
      try { return operation(); }
      catch (error) { refusal = error instanceof Error ? error.message : String(error); return -1; }
    }
    function abort(slot: number, generation: number, side: number) {
      const name = key(slot, generation, side);
      staged.get(name)?.abort(); staged.delete(name);
    }
    function custody(kind: number, first: number, second: number, third: number): BunWasm.LaneCustody {
      if (kind === 0) return { kind: "lane", lane: { slot: first, generation: second }, side: third === 1 ? 1 : 0 };
      return kind === 1 ? { kind: "cell", cell: [first, second] } : { kind: "local" };
    }
    function take(slot: number, generation: number, side: number, limit: number) {
      const name = key(slot, generation, side);
      const kept = received.get(name);
      if (kept) return kept;
      const batch = end(slot, generation, side).drain(limit);
      if (batch.frames.length) received.set(name, batch);
      return batch;
    }
    const table: LaneNatives = {
      laneLedger: () => 4096,
      laneJoin: (_ledger, cell, generation) => member.join([cell, generation]),
      laneCensus: () => null,
      laneRefusal: () => bridged("laneRefusal", () => refusal),
      laneReserve(slot, generation, side, text) {
        bridged("laneReserve", () => {
          abort(slot, generation, side);
          staged.set(key(slot, generation, side), end(slot, generation, side).reserve(text));
        });
      },
      laneDrain(slot, generation, side, limit) {
        const batch = bridged("laneDrain", () => take(slot, generation, side, limit), read => read.frames.length > 0);
        return [batch.frames.slice(), batch.more, batch.terminal];
      },
      laneDrained(slot, generation, side) { received.delete(key(slot, generation, side)); return 0; },
      laneCommit(slot, generation, side) {
        const name = key(slot, generation, side);
        const frame = staged.get(name);
        staged.delete(name);
        return frame?.commit() ? 1 : 0;
      },
      laneAbort(slot, generation, side) { abort(slot, generation, side); return 0; },
      laneCreate: () => refusable(() => { const ref = member.create(); return ref.slot * PAIR + ref.generation; }),
      laneCell: () => refusable(() => { const [index, generation] = member.cell(); return index * PAIR + generation; }),
      laneTransferEpoch: (slot, generation, side) => refusable(() => {
        if (received.has(key(slot, generation, side))) throw new Error(UNDELIVERED);
        return end(slot, generation, side).transferEpoch();
      }),
      laneTransfer(slot, generation, side, kind, first, second, third) {
        abort(slot, generation, side);
        end(slot, generation, side).transfer(custody(kind, first, second, third));
        return 0;
      },
      laneAdopt: (slot, generation, side, epoch, version) => Number(member.adopt({ slot, generation, side: side === 1 ? 1 : 0, epoch }, version)),
      laneCloseRead(slot, generation, side) {
        received.delete(key(slot, generation, side));
        end(slot, generation, side).closeRead();
        return 0;
      },
      laneCloseEnd(slot, generation, side) {
        abort(slot, generation, side); received.delete(key(slot, generation, side));
        return Number(end(slot, generation, side).closeEnd());
      },
      lanePeerClosed: (slot, generation, side) => Number(end(slot, generation, side).peerClosed()),
      laneEnd: (slot, generation, side) => member.end({ slot, generation }, side === 1 ? 1 : 0),
      laneSever(slot, generation, side) { member.sever({ slot, generation }, side === 1 ? 1 : 0); return 0; },
      laneExited(cell, generation) { member.exited([cell, generation]); return 0; },
      laneSweep(full) { control.sweeps.push({ tag, full: Boolean(full) }); return 0; },
      laneEpochs: epochs,
    };
    return new Proxy(table, {
      get(target, name, receiver) {
        if (typeof name === "string") control.calls.push(name);
        return Reflect.get(target, name, receiver);
      },
    });
  }
  /** One member's lanes as its runtime sees them: the real `worker_lane.ts` over the model's natives. */
  function member(tag: number) {
    return sourceLanes(natives(tag));
  }
  return { member, control, lanes };
}

/** A shared-group engine's service object for one source runtime. */
export function groupSharedObjects(groupLanes: BunWasm.GroupLanes): BunWasm.SharedObjects {
  return {
    begin() { throw new Error("No shared objects in this control"); },
    read() { throw new Error("No shared objects in this control"); },
    wait: () => null,
    groupLanes,
  };
}
