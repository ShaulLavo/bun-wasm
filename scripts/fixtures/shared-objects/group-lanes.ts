// A codec and topology control for the shared-group lane protocol: the GroupLanes contract over
// plain arrays, shared by several source runtimes in one process. It is not the lane algorithm;
// crates/bunwasm-runtime/src/wasm/lane.rs and its unit tests own ring, spill, ledger and
// lifetime behavior. This model keeps only what the runtime JavaScript depends on: ownership by
// end, in-flight epochs and custody, reader-closed, terminal, armed and refusal before staging.
import "../../../crates/bunwasm-runtime/src/js/worker_protocol.d.ts";

type End = { state: "open" | "in-flight" | "closed"; owner: number; epoch: number; version: number; custody: BunWasm.LaneCustody | null };
type Direction = { frames: string[]; readerClosed: boolean; armed: boolean; severed: boolean };
type Lane = { ends: [End, End]; directions: [Direction, Direction] };
const STATES = { open: 1, "in-flight": 2, closed: 3 } as const;

export function createGroupLaneModel() {
  const lanes: Lane[] = [];
  const cells: ({ tag: number; open: boolean } | null)[] = [];
  const control = { refuse: false, reserved: 0, drained: 0 };
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
  function closeOrphan(item: Lane, side: 0 | 1) {
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
  function member(tag: number): BunWasm.GroupLanes {
    /** Closing an end that is no longer this member's is a no-op, as in lane.rs. */
    function owns(ref: BunWasm.GroupLaneRef, side: 0 | 1) {
      const end = lane(ref).ends[side];
      return end.state === "open" && end.owner === tag;
    }
    function owned(ref: BunWasm.GroupLaneRef, side: 0 | 1) {
      const found = lane(ref), end = found.ends[side];
      if (end.state !== "open" || end.owner !== tag) throw new Error(`Lane end ${ref.slot}/${side} is not owned by ${tag}`);
      return { found, end };
    }
    function open(ref: BunWasm.GroupLaneRef, side: 0 | 1): BunWasm.GroupSharedLane {
      return {
        ref, side,
        reserve(text) {
          const { found } = owned(ref, side);
          if (control.refuse) throw new DOMException("MessagePort lane storage was refused (errno 48)", "DataCloneError");
          const direction = found.directions[side === 0 ? 1 : 0];
          if (direction.readerClosed) return { commit: () => false, abort() {} };
          control.reserved++;
          let settled = false;
          return {
            commit() {
              if (settled) return false;
              settled = true; direction.frames.push(text);
              const wake = direction.armed; direction.armed = false; return wake;
            },
            abort() { settled = true; },
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
      if (end.state !== "in-flight" || end.epoch !== port.epoch) return null;
      Object.assign(end, { state: "open", owner: tag, epoch: end.epoch + 1, version, custody: null });
      return open({ slot: port.slot, generation: port.generation }, port.side);
    }
    return {
      ledger: () => 4096,
      join(_ledger, cell) { const found = cells[cell[0]]; if (!found?.open) return false; found.tag = tag; return true; },
      create() {
        const end = (): End => ({ state: "open", owner: tag, epoch: 1, version: 0, custody: null });
        const direction = (): Direction => ({ frames: [], readerClosed: false, armed: false, severed: false });
        lanes.push({ ends: [end(), end()], directions: [direction(), direction()] });
        return { slot: lanes.length - 1, generation: 1 };
      },
      open, adopt,
      discard(port, version) { const io = adopt(port, version); io?.closeRead(); io?.closeEnd(); },
      cell() { cells.push({ tag, open: true }); return [cells.length - 1, 1]; },
      exited(cell) {
        const found = cells[cell[0]];
        if (!found?.open) return;
        found.open = false;
        for (const item of lanes) for (const side of [0, 1] as const) {
          const end = item.ends[side];
          if (end.state !== "open" || end.owner !== found.tag || found.tag === tag) continue;
          Object.assign(end, { state: "closed", owner: 0, epoch: end.epoch + 1 });
          item.directions[side].readerClosed = true;
        }
        cascade();
      },
      sweep() {},
      end(ref, side) { const end = lane(ref).ends[side]; return [STATES[end.state], end.version]; },
      sever(ref, side) { lane(ref).directions[side === 0 ? 1 : 0].severed = true; },
      census: () => null,
    };
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
