(function (internal: BunWasm.Internal) {
  "use strict";
  type Route = BunWasm.WorkerRoute;
  type Graph = BunWasm.WorkerGraph;
  type Snapshot = BunWasm.PortSnapshot;
  /** A port node's metadata: the snapshot without its queue, a group lane as its wire array. */
  type PortMeta = Omit<Snapshot, "queue" | "lane" | "groupLane"> & { lane?: [number, number, 0 | 1, number] };
  const native = internal.native;
  const process = internal.require("process");
  const EventEmitter = internal.require("events");
  const clone = internal.require("structured_clone").structuredClone;
  const token = {};
  const untransferable = new WeakSet<object>();
  const environmentData = new Map<unknown, unknown>();
  const messagePayloads = new WeakMap<Event, unknown>();
  const channels = new Map<string, Set<BroadcastChannel>>();
  const localPorts = new Map<string, MessagePort>();
  const deleteLocalPort = localPorts.delete.bind(localPorts);
  let restoredPorts: MessagePort[] | null = null;
  const children = new Map<number, { ref: boolean; send(frame: unknown): void; pump(): boolean; watch(): Uint8Array; event(frame: Record<string, unknown>): void }>();
  type LaneRecord = [slot: number, generation: number, side: 0 | 1];
  const owners = new Map<string, { owner: Route | null; origin: Route; version: number; peer: string | null; sent: number; ready: boolean; lane: LaneRecord | null }>();
  const pending = new Map<string, Record<string, unknown>[]>();
  const members = new Map<string, { route: Route; group: string }>();
  let nextPort = 0;
  let nextWorker = 0;
  let applyingEnv = false;
  let initialized = false;
  let restoringLocally = false;
  let parentPort: MessagePort | null = null;
  let parentChannel: BunWasm.WorkerChannel | null = null;
  let orphaned = false;
  /** A full lane sweep is owed to the next event-loop step (after a `gone` or a parent EOF). */
  let fullSweepDue = false;
  /** The group's end-epoch sum at the root's last broker rescan. */
  let seenEpochs = 0;
  // Shared-group engines carry port messages in group memory (worker_lane.ts); others use pipes.
  const groupLanes = internal.sharedObjects?.groupLanes;
  /** lane.rs end states. */
  const LANE_OPEN = 1;
  const LANE_CLOSED = 3;
  const LANE_DRAIN = 1024;
  const config = workerConfig(process.env.BUNWASM_WORKER_INIT);
  const controlFds = process.env.BUNWASM_WORKER_CONTROL;
  const route = config?.route || [];
  const threadId = route.reduce((parent, counter) => (parent + counter) * (parent + counter + 1) / 2 + counter + 1, 0);
  const envGroup = config?.envGroup || "root";
  const routeKey = (path: Route) => JSON.stringify(path);
  const sameRoute = (first: Route, second: Route) => routeKey(first) === routeKey(second);
  const hasPrefix = (path: Route, prefix: Route) => prefix.every((part, index) => path[index] === part);
  members.set(routeKey(route), { route, group: envGroup });

  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid worker protocol object");
    return value as Record<string, unknown>;
  }
  function parseRoute(value: unknown): Route {
    if (!Array.isArray(value) || !value.every(part => typeof part === "number" && Number.isSafeInteger(part) && part >= 0)) throw new TypeError("Invalid worker route");
    return value;
  }
  function workerConfig(text: string | undefined) {
    if (!text) return null;
    const value = record(JSON.parse(text));
    const path = parseRoute(value.route);
    if (typeof value.envGroup !== "string" || !Array.isArray(value.argv) || !value.argv.every(arg => typeof arg === "string") || !Array.isArray(value.execArgv) || !value.execArgv.every(arg => typeof arg === "string")) throw new TypeError("Invalid worker initialization");
    return { route: path, envGroup: value.envGroup, argv: value.argv, execArgv: value.execArgv,
      graph: value.graph, resourceLimits: limits(value.resourceLimits), web: webOptions(value.web), lanes: laneInit(value.lanes) };
  }
  function laneInit(value: unknown) {
    if (value === undefined) return null;
    const input = record(value);
    const integer = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
    const cell = input.cell;
    if (!integer(input.ledger) || !Array.isArray(cell) || cell.length !== 2 || !cell.every(integer)) throw new TypeError("Invalid worker lane initialization");
    return { ledger: input.ledger as number, cell: [cell[0], cell[1]] as BunWasm.LaneCell };
  }
  function laneRecord(value: unknown): LaneRecord | null {
    if (!Array.isArray(value) || value.length < 3) return null;
    const [slot, generation, side] = value;
    if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(generation) || side !== 0 && side !== 1) return null;
    return [slot, generation, side];
  }
  function webOptions(value: unknown): BunWasm.WebWorkerOptions | null {
    if (value === undefined || value === null) return null;
    const input = record(value);
    if (typeof input.name !== "string" || !Array.isArray(input.preload) || !input.preload.every(path => typeof path === "string")) throw new TypeError("Invalid web worker initialization");
    return { name: input.name, preload: input.preload };
  }
  function invalidArgument(name: string) {
    return Object.assign(new TypeError(`The "${name}" argument has an invalid type`), { code: "ERR_INVALID_ARG_TYPE" });
  }
  function invalidPort() {
    return Object.assign(new TypeError('The "port" argument must be a MessagePort instance'), { code: "ERR_INVALID_ARG_TYPE" });
  }
  function cloneError(message: string) { return new DOMException(message, "DataCloneError"); }
  function markAsUntransferable(value: unknown) {
    if (value !== null && (typeof value === "object" || typeof value === "function")) untransferable.add(value);
  }
  function isMarkedAsUntransferable(value: unknown) {
    return value !== null && (typeof value === "object" || typeof value === "function") && untransferable.has(value);
  }
  internal.isMarkedAsUntransferable = isMarkedAsUntransferable;
  function messageEvent(data: unknown, ports: MessagePort[] = []) {
    const event = new MessageEvent("message", { data, ports });
    messagePayloads.set(event, data);
    return event;
  }
  function webMessageEvent(event: MessageEvent) {
    const data = messagePayloads.has(event) ? messagePayloads.get(event) : event.data;
    return Object.assign(new MessageEvent("message", { data }), { data, ports: event.ports });
  }
  function transfers(value: unknown) {
    if (value == null) return [];
    if (typeof value !== "object") throw invalidArgument("transferList");
    if (Symbol.iterator in value) return Array.from(value as Iterable<unknown>);
    if (!("transfer" in value)) return [];
    const list = value.transfer;
    if (!list || typeof list !== "object" || !(Symbol.iterator in list)) throw invalidArgument("options.transfer");
    return Array.from(list as Iterable<unknown>);
  }

  function down(path: Route, body: Record<string, unknown>) {
    if (sameRoute(path, route)) { direct(body); return; }
    if (!hasPrefix(path, route)) { parentChannel?.send({ kind: "down", path, body }); return; }
    const child = children.get(path[route.length]);
    child?.send({ kind: "down", path, body });
  }
  function root(body: Record<string, unknown>) {
    const routes = internal.sharedObjects?.routes;
    if (routes?.enabled && (body.kind === "bind" || body.kind === "moving" || body.kind === "port-data" || body.kind === "port-close" || body.kind === "closed")) {
      if (!routes.send(body)) throw cloneError("Shared route mailbox is full");
      return;
    }
    if (route.length) { parentChannel?.send({ kind: "up", body }); return; }
    rootCommand(body);
  }
  function incoming(frame: unknown) {
    const value = record(frame);
    if (value.kind === "up") { root(record(value.body)); return; }
    if (value.kind === "down") { down(parseRoute(value.path), record(value.body)); return; }
    throw new Error("Unknown worker control frame");
  }
  function own(snapshot: Omit<Snapshot, "queue">, owner: Route | null, origin: Route, ready = true, lane: LaneRecord | null = null) {
    const previous = owners.get(snapshot.id);
    if (previous && previous.version > snapshot.version) return;
    // Legacy delivery can claim the new owner before the sender's moving frame arrives.
    if (previous?.version === snapshot.version && previous.owner !== null && owner === null) return;
    owners.set(snapshot.id, { owner, origin, version: snapshot.version, peer: snapshot.peer, sent: snapshot.sent, ready, lane: lane ?? previous?.lane ?? null });
    if (!owner || !ready) return;
    const waiting = pending.get(snapshot.id) || [];
    pending.delete(snapshot.id);
    for (const packet of waiting) routePacket(packet);
  }
  function snapshotRecord(value: unknown): Omit<Snapshot, "queue"> {
    const item = record(value);
    if (typeof item.id !== "string" || item.peer !== null && typeof item.peer !== "string" || typeof item.version !== "number" || typeof item.sent !== "number" || typeof item.received !== "number" || !Array.isArray(item.pending) || item.closing !== null && typeof item.closing !== "number" || typeof item.closed !== "boolean") throw new Error("Invalid port ownership record");
    return { id: item.id, peer: item.peer, version: item.version, sent: item.sent, received: item.received, pending: [], closing: item.closing, closed: item.closed };
  }
  function claimTransferred(graph: unknown, owner: Route) {
    const value = record(graph);
    if (!Array.isArray(value.nodes)) throw new Error("Invalid worker graph");
    for (const node of value.nodes) {
      if (!Array.isArray(node) || node[0] !== "port") continue;
      own(snapshotRecord(node[1]), owner, owner, false, laneRecord(record(node[1]).lane));
    }
  }
  function registerLocalTransfers(graph: Graph) {
    for (const node of graph.nodes) {
      if (node[0] === "port") registerLocalPort(node[1]);
    }
  }
  function registerLocalPort(snapshot: PortMeta) {
    root({ kind: "bind", snapshot, owner: route });
    for (const [, graph] of snapshot.pending) registerLocalTransfers(graph);
  }
  function discardPendingTransfers(graph: Graph) {
    for (const node of graph.nodes) {
      if (node[0] === "port") discardPendingPort(node[1]);
    }
  }
  function discardPendingPort(snapshot: PortMeta) {
    // A carried end that will never be restored closes, so its peer sees the channel end.
    if (groupLanes && snapshot.lane) groupLanes.discard({ slot: snapshot.lane[0], generation: snapshot.lane[1], side: snapshot.lane[2], epoch: snapshot.lane[3] }, snapshot.version);
    root({ kind: "closed", id: snapshot.id });
    for (const [, graph] of snapshot.pending) discardPendingTransfers(graph);
  }
  /**
   * The received graph that is being made into a message, on an engine with group lanes. From
   * before its first carried end is taken until the message is queued, this record owns those
   * ends. A failure anywhere in that stretch, also inside a port's constructor after it took
   * its end, marks the graph failed, and `settleReceived` closes everything it carried. The
   * record exists from the start, so owning a graph and keeping a failed one allocate nothing.
   * One graph is taken at a time: the next waits until a failed one is settled.
   */
  const receiving: { graph: Graph | null; failed: boolean } = { graph: null, failed: false };
  /**
   * Closes what a failed graph carried: a port already built from it, an end a port took
   * before its constructor failed, and an end still in flight. A local port with a carried
   * port's id can only be the one built from this graph, because the end was nowhere else.
   * Every step does nothing the second time, and the graph is let go last.
   */
  function settleReceived() {
    const graph = receiving.graph;
    if (!graph || !receiving.failed) return;
    for (const node of graph.nodes) {
      if (node[0] !== "port") continue;
      const built = localPorts.get(node[1].id);
      if (built) portOps.discard(built);
      discardPendingPort(node[1]);
    }
    receiving.graph = null; receiving.failed = false;
  }
  /** True when no graph is held. A failed graph whose ends could not be closed yet stays held. */
  function receivedSettled(): boolean {
    try { settleReceived(); }
    catch { /* still owed */ }
    return !receiving.graph;
  }
  function routePacket(body: Record<string, unknown>) {
    if (typeof body.id !== "string") return;
    const endpoint = owners.get(body.id);
    if (!endpoint) return;
    if (!endpoint.owner || !endpoint.ready) {
      const packets = pending.get(body.id) || [];
      packets.push(body); pending.set(body.id, packets); return;
    }
    if (body.kind === "port-data") claimTransferred(body.graph, endpoint.owner);
    down(endpoint.owner, body);
  }
  function rootCommand(body: Record<string, unknown>) {
    switch (body.kind) {
      case "claim": claimTransferred(body.graph, parseRoute(body.owner)); return;
      case "bind": own(snapshotRecord(body.snapshot), parseRoute(body.owner), parseRoute(body.owner), true, laneRecord(body.lane)); return;
      case "moving": own(snapshotRecord(body.snapshot), null, parseRoute(body.origin), false, laneRecord(body.lane)); return;
      case "port-wake": {
        // A hint only: the owner drains on its next pump anyway, so an unknown owner drops it.
        const endpoint = typeof body.id === "string" ? owners.get(body.id) : undefined;
        if (endpoint?.owner && endpoint.ready) down(endpoint.owner, body);
        return;
      }
      case "port-data": case "port-close": {
        if (typeof body.from === "string" && typeof body.sequence === "number") {
          const source = owners.get(body.from); if (source) source.sent = Math.max(source.sent, body.sequence + (body.kind === "port-data" ? 1 : 0));
        }
        routePacket(body); return;
      }
      case "closed": if (typeof body.id === "string") { owners.delete(body.id); pending.delete(body.id); } return;
      case "member": {
        const path = parseRoute(body.path);
        if (typeof body.group !== "string") throw new Error("Invalid environment group");
        members.set(routeKey(path), { route: path, group: body.group }); return;
      }
      case "env": {
        const source = parseRoute(body.source);
        for (const member of members.values()) {
          if (member.group === body.group && !sameRoute(member.route, source)) down(member.route, body);
        }
        return;
      }
      case "broadcast": {
        const source = parseRoute(body.source);
        for (const member of members.values()) if (!sameRoute(member.route, source)) down(member.route, body);
        return;
      }
      case "gone": {
        const path = parseRoute(body.path);
        for (const [key, member] of members) if (hasPrefix(member.route, path)) members.delete(key);
        for (const [id, endpoint] of owners) {
          if (!hasPrefix(endpoint.owner || endpoint.origin, path)) continue;
          severOrphan(endpoint, path);
          if (endpoint.peer) routePacket({ kind: "port-close", id: endpoint.peer, sequence: endpoint.sent });
          owners.delete(id); pending.delete(id);
        }
        // A broker command can arrive inside a synchronous receive; the sweep waits for a step.
        fullSweepDue = true;
        return;
      }
      default: throw new Error("Unknown worker broker command");
    }
  }
  /**
   * A lane end still open at the version its gone owner bound is held by a live descendant of a
   * gone route: its peer stops waiting for it. An end that moved on or closed is left alone; a
   * lane-backed peer ignores the broker close below until its lane says the writer is gone.
   */
  function severOrphan(endpoint: { owner: Route | null; version: number; lane: LaneRecord | null }, path: Route) {
    if (!groupLanes || !endpoint.lane || !endpoint.owner || !hasPrefix(endpoint.owner, path)) return;
    const ref = { slot: endpoint.lane[0], generation: endpoint.lane[1] };
    const [state, version] = groupLanes.end(ref, endpoint.lane[2]);
    if (state === LANE_OPEN && version <= endpoint.version) groupLanes.sever(ref, endpoint.lane[2]);
  }
  /**
   * Work a finished send still owes, such as the withdrawal of a publication it never committed,
   * tried again on every step until it is done. A failure here is not this thread's error: what
   * is owed stays listed and the next step asks again.
   */
  function settleOwed() {
    try { settlePosts(true); internal.sharedObjects?.settle?.(); }
    catch { /* still owed */ }
  }
  /**
   * Group lane housekeeping, on ordinary event-loop steps only: a sweep may call the group owner,
   * which on the Browser host is the page, so it never runs inside `receiveMessageOnPort`.
   */
  function laneHousekeeping() {
    if (!groupLanes) return;
    // A worker learns its parent is gone when the parent's channel ends.
    if (parentChannel?.ended && !orphaned) { orphaned = true; fullSweepDue = true; }
    const full = fullSweepDue;
    fullSweepDue = false;
    groupLanes.sweep(full);
    if (!route.length) retireClosedLanes();
  }
  /**
   * At the root, after the sweep: a cascade or a release can close an end whose owner sends no
   * frame, such as a port carried in a frame its dead receiver never read. Retire those records
   * and close their peers, which also wakes an idle peer's loop. Ends in flight, open or closed
   * by an exit report keep their records. The rescan is due whenever any end changed state: that
   * is read from the end words themselves, so a member that closed an end and died at once has
   * still announced it. The sum is read before the scan, so a closure during it is seen next step.
   */
  function retireClosedLanes() {
    const epochs = groupLanes!.epochs();
    if (epochs === seenEpochs) return;
    seenEpochs = epochs;
    for (const [id, endpoint] of owners) {
      if (!endpoint.lane) continue;
      const [state] = groupLanes!.end({ slot: endpoint.lane[0], generation: endpoint.lane[1] }, endpoint.lane[2]);
      if (state !== LANE_CLOSED) continue;
      if (endpoint.peer) routePacket({ kind: "port-close", id: endpoint.peer, sequence: endpoint.sent });
      owners.delete(id); pending.delete(id);
    }
  }
  function direct(body: Record<string, unknown>) {
    if (body.kind === "port-wake") {
      const port = typeof body.id === "string" ? localPorts.get(body.id) : undefined;
      if (port) portOps.drainLane(port);
      return;
    }
    if (body.kind === "port-data" || body.kind === "port-close") {
      if (typeof body.id !== "string" || typeof body.sequence !== "number") throw new Error("Invalid port packet");
      const port = localPorts.get(body.id);
      if (!port) { root(body); return; }
      portOps.receivePacket(port, body.kind, body.sequence, body.graph); return;
    }
    if (body.kind === "env") {
      if (typeof body.key !== "string" || body.value !== undefined && typeof body.value !== "string") throw new Error("Invalid environment update");
      applyingEnv = true;
      try { if (body.value === undefined) delete process.env[body.key]; else process.env[body.key] = body.value; }
      finally { applyingEnv = false; }
      return;
    }
    if (body.kind === "broadcast" && typeof body.name === "string") {
      for (const channel of channels.get(body.name) || []) BroadcastChannel.receive(channel, strictCodec.decode(body.graph));
      return;
    }
    if (typeof body.child === "number") { children.get(body.child)?.event(body); return; }
    throw new Error("Unknown worker delivery");
  }
  function mailboxDelivery(body: Record<string, unknown>) {
    const routes = internal.sharedObjects?.routes;
    if (!routes || typeof body.receipt !== "string") throw new Error("Missing mailbox receipt");
    if (typeof body.id !== "string") throw new Error("Invalid mailbox target");
    if (!localPorts.has(body.id)) return routes.send({ kind: "returned", receipt: body.receipt });
    direct(body);
    return routes.send({ kind: "received", receipt: body.receipt });
  }
  function decodeReceived(graph: Graph) {
    const routes = internal.sharedObjects?.routes;
    if (!routes?.enabled || restoringLocally) return messagePacket(codec.decode(graph));
    if (!routes.tryTransaction(() => registerLocalTransfers(graph), () => {})) return null;
    const created: MessagePort[] = [];
    restoredPorts = created; restoringLocally = true;
    try { return messagePacket(codec.decode(graph)); }
    catch (error) { for (const port of created) portOps.discard(port); discardPendingTransfers(graph); throw error; }
    finally { restoredPorts = null; restoringLocally = false; }
  }
  function sharedLanes() {
    const shared = internal.sharedObjects;
    return shared?.routes?.enabled ? shared.lanes : undefined;
  }
  function pump() {
    // The loop also pumps outside the waiter's step, and a frame handled here may name a port
    // that a refused post has not put back yet. A failure to settle is not the pump's: what is
    // owed stays listed for the next step or entry.
    try { settlePosts(); }
    catch { /* still owed */ }
    // Ends a failed message carried and that could not be closed when it failed.
    const unsettled = groupLanes !== undefined && !receivedSettled();
    const shared = internal.sharedObjects;
    // Lanes first: a broker close behind lane data must not overtake it. A group lane left with
    // data past its drain quota counts as progress, so the loop steps again before sleeping.
    let lanes = false;
    // A lane whose drain fails has lost nothing: the core keeps what it read for the next pump.
    // Every other port, the mailbox and the control channels are still served in this one, and
    // the first failure is thrown once they are, so it is reported and nothing waits behind it.
    let failed: { error: unknown } | null = null;
    for (const port of Array.from(localPorts.values())) {
      try { lanes = portOps.drainLane(port) || lanes; }
      catch (error) { failed ??= { error }; }
    }
    const drained = shared?.routes?.enabled ? shared.mailbox?.drain(bytes => mailboxDelivery(record(JSON.parse(native.utf8Decode(bytes))))) || 0 : 0;
    if (drained) shared?.routes?.credit();
    let owed = false;
    for (const port of localPorts.values()) owed = portOps.retry(port) || owed;
    let progress = Boolean(drained) || lanes || owed || unsettled;
    progress = parentChannel?.pump(incoming) || progress;
    for (const child of Array.from(children.values())) progress = child.pump() || progress;
    if (failed) throw failed.error;
    return progress;
  }

  function messagePacket(value: unknown) {
    const packet = record(value);
    if (!("data" in packet) || !Array.isArray(packet.ports) || !packet.ports.every(port => port instanceof MessagePort)) throw new Error("Invalid worker message packet");
    return { data: packet.data, ports: packet.ports };
  }
  interface DeliveryBatch { queue: unknown[]; remaining: number; }
  interface PortState {
    id: string; peer: string | null; version: number; sent: number; received: number;
    queue: unknown[]; pending: Map<number, Graph>; peerClosing: number | null;
    lane: (BunWasm.PortLane & { io: BunWasm.SharedLane; stop: () => void }) | null;
    /** `backlog`: the last drain stopped at its quota. `terminal`: the writing end is gone and drained. */
    group: { io: BunWasm.GroupSharedLane; backlog: boolean; terminal: boolean } | null;
    phase: "open" | "closing" | "closed";
    batch: DeliveryBatch | null;
    started: boolean;
    /**
     * `scheduled` is the turn of the delivery callback known to be queued, or 0. It is set only
     * after the call that queues the callback has returned, so a call that failed leaves no
     * claim that a callback exists. `turn` numbers every attempt: a callback runs only while its
     * turn is the latest, so one queued by a call that then failed is overtaken by the retry.
     */
    scheduled: number; turn: number;
  }
  /**
   * A post over a group lane. It commits in one native call, the last thing `postMessage` does:
   * `transferArrayBuffers` checks everything once more, then detaches the buffers, moves the
   * carried ports and publishes the frame, and returns. A caller that catches an exception has
   * moved nothing, and one that sees the call return has published the whole message.
   *
   * So nothing can run after that call. Whatever must be true locally when it returns is done
   * before it and undone if it refuses (`rollBack`). What the post owes others afterward (broker
   * records, the publication's commit, the wake hint) is not needed for the message to be whole
   * and is finished at the next entry into this module or the next loop step (`finish`).
   *
   * - `gathering`: the codec is walking the message. The only phase that runs user code.
   * - `staged`: the frame and its ports are being staged. No user code from here on.
   * - `committing`: the next thing is the native call, or it has been made.
   * - `abandoned`: given up; an interrupted `rollBack` is finished later.
   */
  type GroupPost = {
    phase: "gathering" | "staged" | "committing" | "abandoned";
    readonly state: PortState; readonly io: BunWasm.GroupSharedLane; readonly peer: string;
    /** The sequence this post took, once it advanced `state.sent`; -1 before. */
    sequence: number;
    /** Names this post's commit in the core. Never reused; 0 before one is taken. */
    nonce: number;
    plan: BunWasm.PreparedSend | null;
    ports: BunWasm.StagedPort[];
  };
  /** Every post from the start of its gather until it is finished or rolled back. */
  const posts = new Set<GroupPost>();
  /** The last nonce taken. A nonce and a wake bit fit one exact number up to this many (lane.rs). */
  let nonces = 0;
  const MAX_NONCE = 2 ** 52 - 1;
  const WORD = 2 ** 32;
  const MAX_VERSION = WORD - 1;
  /** The arguments of the call that commits a post. */
  type CommitCall = [buffers: ArrayBuffer[], slot: number, generation: number, side: number, nonceHigh: number, nonceLow: number, refuse: (message: string) => unknown];
  // `rollBack` and `finish` can be interrupted anywhere and are then run again. Each step is an
  // assignment, a set or map operation or a word native that does nothing the second time, and
  // the post leaves the registry last.
  /** Undoes a post that did not commit: nothing of it had moved. */
  function rollBack(post: GroupPost) {
    post.phase = "abandoned";
    post.io.abort();
    for (const port of post.ports) port.restore();
    if (post.sequence >= 0) post.state.sent = post.sequence;
    post.plan?.settle(false);
    internal.native.transferSettled?.();
    posts.delete(post);
  }
  /** What a committed post still owes others. A record or hint sent twice changes nothing. */
  function finish(post: GroupPost, wake: boolean) {
    internal.native.transferSettled?.();
    for (const port of post.ports) port.moved();
    post.plan?.settle(true);
    // The peer slept on an empty lane: the hint only wakes its loop sooner.
    if (wake) root({ kind: "port-wake", id: post.peer });
    posts.delete(post);
  }
  function settlePost(post: GroupPost, loop: boolean, nonce: number, wake: boolean) {
    // A post still gathering may be an outer `postMessage` whose getter is running this call.
    if (post.phase === "gathering" && !loop) return;
    // The core says whether the commit happened. A post whose call threw has a nonce the core
    // never recorded, whatever its own cleanup managed to do.
    if (post.phase === "committing" && post.nonce === nonce) finish(post, wake);
    else rollBack(post);
  }
  /**
   * Finishes earlier posts, before anything here reads the state they left. `loop` is the worker
   * loop's step, which runs inside no post: there a post still gathering was interrupted beyond
   * its own cleanup and is rolled back.
   */
  function settlePosts(loop = false) {
    if (!posts.size || !groupLanes) return;
    const [nonce, wake] = groupLanes.committed();
    for (const post of posts) settlePost(post, loop, nonce, wake);
  }
  /** Names a carried port's lane end under the staged frame. A port with no lane left carries none. */
  function stageEnd(io: BunWasm.GroupSharedLane, port: BunWasm.PortTransfer) {
    const lane = port.snapshot.groupLane;
    if (lane && io.stageEnd(lane) !== lane.epoch) throw cloneError("MessagePort changed during transfer");
  }
  /**
   * Stages a post: every fallible step, with nothing moved. Returns the arguments of the call
   * that commits it. Only `codec.prepare` runs user code, and a post made from inside it settles
   * before this one stages anything.
   */
  function stagePost(post: GroupPost, packet: unknown, list: unknown[]): CommitCall {
    const { state, io } = post;
    // Ports this message carries wait in the custody of the lane end that will read it.
    const custody: BunWasm.LaneCustody = { kind: "lane", lane: io.ref, side: io.side === 0 ? 1 : 0 };
    const plan = post.plan = codec.prepare(packet, list, [state.id, post.peer], custody);
    // A post made from inside the gather has committed and must be finished before this one
    // commits: the core remembers one commit, the last, and that is how a post is recognized.
    settlePosts();
    // A loop step that ran inside the gather gave this post up, and its publications with it.
    if (post.phase !== "gathering") throw cloneError("MessagePort changed during transfer");
    post.phase = "staged";
    const send = plan.stage();
    if (nonces >= MAX_NONCE || !Number.isSafeInteger(state.sent + 1)) throw cloneError("MessagePort has sent too many messages");
    io.stage(JSON.stringify({ kind: "port-data", sequence: state.sent, graph: plan.graph }));
    for (const port of send.ports) stageEnd(io, port);
    for (const port of send.ports) {
      // Listed before it detaches, so a rollback restores a port whose detach was interrupted.
      const staged = port.stage!();
      post.ports.push(staged); staged.detach();
    }
    post.nonce = ++nonces;
    post.sequence = state.sent; state.sent = post.sequence + 1;
    post.phase = "committing";
    const refuse = (message: string) => { rollBack(post); return cloneError(message); };
    return [send.buffers, io.ref.slot, io.ref.generation, io.side, Math.floor(post.nonce / WORD), post.nonce % WORD, refuse];
  }
  /** Registers a post and stages it. A post that cannot be staged is rolled back and throws. */
  function beginPost(state: PortState, io: BunWasm.GroupSharedLane, peer: string, packet: unknown, list: unknown[]): CommitCall {
    const post: GroupPost = { phase: "gathering", state, io, peer, sequence: -1, nonce: 0, plan: null, ports: [] };
    posts.add(post);
    try { return stagePost(post, packet, list); }
    catch (error) {
      // What an interrupted rollback leaves is still registered, and the next settle finishes it.
      try { rollBack(post); } catch { /* still registered */ }
      throw error;
    }
  }
  class MessagePort extends EventTarget {
    #state: PortState | null;
    #webListeners = new Map<EventListenerOrEventListenerObject, Set<boolean>>();
    #onmessage: ((event: MessageEvent) => unknown) | null = null;
    #attachmentWait: (() => void) | null = null;
    onmessageerror: ((event: MessageEvent) => unknown) | null = null;
    constructor(key: object, snapshot?: Snapshot) {
      super();
      if (key !== token) throw Object.assign(new TypeError("Illegal constructor"), { code: "ERR_CONSTRUCT_CALL_INVALID" });
      const id = `${internal.sharedObjects?.routes?.enabled ? internal.sharedObjects.routes.owner : routeKey(route)}:${nextPort++}`;
      const value = snapshot || { id, peer: null, version: 0, sent: 0, received: 0, queue: [], pending: [], closing: null, closed: false };
      this.#state = { id: value.id, peer: value.peer, version: value.version, sent: value.sent, received: value.received, queue: value.queue,
        pending: new Map(value.pending), peerClosing: value.closing, lane: null, group: null,
        phase: value.closed ? "closed" : "open", batch: null, started: false, scheduled: 0, turn: 0 };
      if (value.lane && !value.closed) this.#openLane(value.lane);
      if (value.groupLane && !value.closed) this.#adoptGroupLane(value.groupLane, value.version);
      localPorts.set(value.id, this);
      EventEmitter.call(this);
      super.addEventListener("message", event => {
        if (event instanceof MessageEvent) this.emit("message", messagePayloads.has(event) ? messagePayloads.get(event) : event.data);
      });
      super.addEventListener("messageerror", event => { if (event instanceof MessageEvent) this.emit("messageerror", event.data); });
      super.addEventListener("close", () => this.emit("close"));
    }
    static #pair(): [MessagePort, MessagePort] {
      const first = new MessagePort(token); const second = new MessagePort(token);
      first.#value().peer = second.#value().id; second.#value().peer = first.#value().id;
      const bind = () => { first.#bind(); second.#bind(); };
      try {
        const routes = internal.sharedObjects?.routes;
        if (routes?.enabled) routes.transaction(bind, () => {});
        else bind();
      } catch (error) { MessagePort.#discard(first); MessagePort.#discard(second); throw error; }
      return [first, second];
    }
    static #discard(port: MessagePort) {
      port.#closeLane(true); localPorts.delete(port.#value().id); port.#state = null;
    }
    // A channel whose ends live in different processes carries its packets in its own shared lane.
    #openLane(lane: BunWasm.PortLane) {
      const lanes = sharedLanes(), state = this.#value();
      if (!lanes || state.lane) return;
      const io = lanes.open(lane, lane.side);
      state.lane = { ...lane, io, stop: io.watch(() => internal.realTimers.setImmediate(pump)) };
    }
    /** Takes this end of a group lane in decode: memory only. An end closed first restores closed. */
    #adoptGroupLane(lane: BunWasm.GroupPortLane, version: number) {
      const state = this.#value();
      if (!groupLanes) { state.phase = "closed"; return; }
      // The end's wrapper and record are made before the end is taken.
      const group = { io: groupLanes.open({ slot: lane.slot, generation: lane.generation }, lane.side), backlog: false, terminal: false };
      if (groupLanes.adopt(lane, version)) state.group = group;
      else state.phase = "closed";
    }
    /** Stops reading the lane: for good when the port closes, or until a transferred port's next owner reads it. */
    #closeLane(closed: boolean) {
      const state = this.#state;
      const group = state?.group;
      if (state && group) {
        state.group = null;
        if (closed) MessagePort.#closeGroupLane(state, group.io);
      }
      if (!state?.lane) return;
      if (closed) state.lane.io.close();
      state.lane.stop(); state.lane = null;
    }
    /** Closes this end; the peer then reads every committed frame and sees the lane end. */
    static #closeGroupLane(state: PortState, io: BunWasm.GroupSharedLane) {
      io.closeRead();
      const wake = io.closeEnd();
      const other = state.peer === null ? undefined : localPorts.get(state.peer);
      if (other) MessagePort.#drainLane(other);
      else if (wake && state.peer) root({ kind: "port-wake", id: state.peer });
    }
    #ensureLane() {
      const state = this.#value(), lanes = sharedLanes();
      const other = state.peer === null ? undefined : localPorts.get(state.peer);
      if (groupLanes) { MessagePort.#ensureGroupLane(state, other); return; }
      if (state.lane || !lanes || !other) return;
      if (!other.#state || other.#state.lane) return;
      const backing = lanes.create();
      this.#openLane({ ...backing, side: 0 }); other.#openLane({ ...backing, side: 1 });
    }
    static #ensureGroupLane(state: PortState, other: MessagePort | undefined) {
      const peer = other ? other.#state : null;
      if (state.group || !peer || peer.group || !groupLanes) return;
      // Both ends and their records exist before the lane does. A failure up to `create` leaves
      // no lane, and after it there are two stores: never a lane with one end, or with none.
      const ref = { slot: 0, generation: 0 };
      const mine = { io: groupLanes.open(ref, 0), backlog: false, terminal: false };
      const theirs = { io: groupLanes.open(ref, 1), backlog: false, terminal: false };
      groupLanes.create(ref);
      state.group = mine; peer.group = theirs;
    }
    static #lanePacket(state: PortState, text: string) {
      const body = record(JSON.parse(text));
      if (typeof body.sequence !== "number" || body.kind !== "port-data" && body.kind !== "port-close") throw new Error("Invalid lane packet");
      if (body.kind === "port-close") state.peerClosing = Math.max(state.peerClosing ?? 0, body.sequence);
      else if (body.sequence >= state.received) state.pending.set(body.sequence, body.graph as Graph);
    }
    /** Returns whether the drain made progress or left data for the next pump. */
    static #drainLane(port: MessagePort, defer = false): boolean {
      const state = port.#state;
      if (state?.group) return MessagePort.#drainGroupLane(port, state, state.group, defer);
      if (!state?.lane || state.phase !== "open") return false;
      let arrived = false;
      state.lane.io.drain(text => {
        MessagePort.#lanePacket(state, text);
        arrived = true;
      });
      if (arrived && !defer && state.phase === "open") port.#accept();
      return false;
    }
    static #drainGroupLane(port: MessagePort, state: PortState, group: NonNullable<PortState["group"]>, defer: boolean) {
      if (state.phase !== "open") return false;
      const { frames, more, terminal } = group.io.drain(LANE_DRAIN);
      for (const text of frames) MessagePort.#lanePacket(state, text);
      group.backlog = more; group.terminal = terminal;
      // The writer is gone and every frame it committed is here: nothing later can arrive.
      if (terminal) state.peerClosing = Math.max(state.peerClosing ?? 0, MessagePort.#nextSequence(state));
      if ((frames.length || terminal) && !defer && state.phase === "open") port.#accept();
      return frames.length > 0 || more;
    }
    static #nextSequence(state: PortState) {
      let next = state.received;
      for (const sequence of state.pending.keys()) next = Math.max(next, sequence + 1);
      return next;
    }
    /** Reserves a packet on the lane, visible to the peer's owner once committed; null when the lane is full. */
    #laneFrame(packet: Record<string, unknown>) {
      return this.#value().lane?.io.reserve(JSON.stringify(packet)) ?? null;
    }
    /** Sends this end's close behind its lane data; false when it must take the broker. A closed peer needs none. */
    #laneClose(sent: number) {
      const group = this.#value().group;
      if (group) { this.#groupLaneClose(group.io, sent); return true; }
      const lane = this.#value().lane;
      if (!lane) return false;
      if (lane.io.peerClosed()) return true;
      let frame: ReturnType<typeof lane.io.reserve>;
      try { frame = lane.io.reserve(JSON.stringify({ kind: "port-close", sequence: sent })); }
      catch (error) {
        if (lane.io.peerClosed()) return true;
        throw error;
      }
      frame?.commit();
      return frame !== null;
    }
    /** The close record carries this end's sequence behind its data. The end's own close, which
     * follows, is what tells the peer nothing more comes, so a refused record changes no outcome. */
    #groupLaneClose(io: BunWasm.GroupSharedLane, sent: number) {
      if (io.peerClosed()) return;
      let frame: BunWasm.GroupLaneFrame;
      try { frame = io.reserve(JSON.stringify({ kind: "port-close", sequence: sent })); }
      catch { return; }
      if (frame.commit() && this.#value().peer) root({ kind: "port-wake", id: this.#value().peer });
    }
    /**
     * Stages a message inside the codec transaction. A lane frame must be reserved here, before
     * transfers detach: a full lane rejects the message rather than accept it where the peer's
     * owner cannot see the complete frame at once. A group lane's post never comes here: it is
     * staged by `stagePost` and committed by the transfer native.
     */
    #stagePacket(graph: Graph, sequence: number, other: MessagePort | undefined) {
      const state = this.#value();
      if (other) {
        if (internal.sharedObjects?.routes?.enabled) registerLocalTransfers(graph);
        return null;
      }
      // A shared-group engine never carries port data on the pipe.
      if (groupLanes) throw cloneError("MessagePort has no lane to its peer");
      if (!state.lane) { root({ kind: "port-data", id: state.peer, from: state.id, sequence, graph }); return null; }
      const frame = this.#laneFrame({ kind: "port-data", sequence, graph });
      if (!frame) throw cloneError("MessagePort lane is full: the receiver has not read 1 MiB of earlier messages");
      return frame;
    }
    #value() { if (!this.#state) throw cloneError("MessagePort is detached"); return this.#state; }
    #snapshot(version = this.#value().version, groupLane: BunWasm.GroupPortLane | null = null): Snapshot {
      const state = this.#value();
      return { id: state.id, peer: state.peer, version, sent: state.sent, received: state.received,
        queue: state.queue.slice(), pending: Array.from(state.pending), closing: state.peerClosing, closed: state.phase === "closed",
        lane: state.lane ? { buffer: state.lane.buffer, side: state.lane.side, poolIndex: state.lane.poolIndex } : null, groupLane };
    }
    /** The broker keeps a lane-backed endpoint's lane so its retire rule can read the end's state. */
    #laneRecord(): LaneRecord | null {
      const io = this.#state?.group?.io;
      return io ? [io.ref.slot, io.ref.generation, io.side] : null;
    }
    #bind() {
      if (restoringLocally) return;
      const { queue: _queue, lane: _lane, groupLane: _groupLane, ...snapshot } = this.#snapshot(); root({ kind: "bind", snapshot, owner: route, lane: this.#laneRecord() });
    }
    static #restore(snapshot: Snapshot) {
      const port = new MessagePort(token, snapshot);
      restoredPorts?.push(port); return port;
    }
    static #activate(value: unknown) { if (!(value instanceof MessagePort)) throw invalidPort(); value.#bind(); value.#accept(); }
    static #prepare(value: unknown): BunWasm.PortTransfer {
      if (!(value instanceof MessagePort)) throw invalidPort();
      settlePosts();
      const state = value.#value();
      if (state.phase !== "open") throw cloneError("Cannot transfer a closed MessagePort");
      // Packets still on this side's lane wait there for the new owner.
      value.#ensureLane();
      // The epoch this end will have in flight; refused here, before anything moves, if it would wrap.
      const group = state.group?.io;
      const groupLane = group ? { ...group.ref, side: group.side, epoch: group.transferEpoch() } : null;
      // The lane's version word is 32 bits and its top value means "none".
      if (groupLane && state.version + 1 >= MAX_VERSION) throw cloneError("MessagePort has moved too many times");
      const snapshot = value.#snapshot(state.version + 1, groupLane);
      const lane = value.#laneRecord();
      /** Tells the broker the port is on its way. Sent again, it changes nothing. */
      const moved = () => {
        const { queue: _queue, lane: _lane, groupLane: _groupLane, ...metadata } = snapshot;
        root({ kind: "moving", snapshot: metadata, origin: route, lane });
      };
      return {
        snapshot,
        validate() {
          if (value.#state !== state || state.phase !== "open") throw cloneError("MessagePort changed during transfer");
          // Checked again right before detachment: the end must still be this thread's at that
          // epoch, with no frames read for this thread and not yet taken.
          if (group && groupLane && group.transferEpoch() !== groupLane.epoch) throw cloneError("MessagePort changed during transfer");
        },
        publish(toward?: string) {
          if (!internal.sharedObjects?.routes?.enabled) return;
          const { queue: _queue, lane: _lane, ...metadata } = snapshot;
          root({ kind: "moving", snapshot: metadata, origin: route, toward });
        },
        beforeCommit() { value.#attachmentWait?.(); value.#attachmentWait = null; },
        commit(custody) {
          internal.messagePortRefs.delete(state);
          // The end goes in flight in the ledger; the frame that carries it is published after.
          state.group?.io.transfer(custody);
          value.#closeLane(false); deleteLocalPort(state.id); value.#state = null;
          if (internal.sharedObjects?.routes?.enabled) return;
          moved();
        },
        // For a post that commits in one native call: the same local steps as `commit`, taken
        // before that call and undone by `restore` when it refuses. The ledger is not touched
        // here; the native moves the end.
        stage() {
          const held = state.group, referenced = internal.messagePortRefs.has(state);
          return {
            detach() {
              internal.messagePortRefs.delete(state);
              value.#closeLane(false); deleteLocalPort(state.id); value.#state = null;
            },
            // Everything the port was doing resumes: its keepalive, the delivery of what is
            // queued, and the wait for an attachment that staging cancelled.
            restore() {
              value.#state = state; state.group = held; localPorts.set(state.id, value);
              if (referenced) internal.messagePortRefs.add(state);
              if (state.phase === "open") value.#accept();
              else value.#schedule();
            },
            moved,
          };
        },
      };
    }
    static #receive(port: MessagePort) {
      const state = port.#state;
      if (!state) return undefined;
      if (!state.queue.length) {
        if (!port.#attachmentWait) return undefined;
        // The head frame cannot decode in this synchronous turn. It stays pending, whole, and delivers once this thread's event loop runs.
        throw Object.assign(new Error("receiveMessageOnPort: the next message needs a shared backing that is not attached in this thread; it will be delivered once this thread's event loop runs"), { code: "ERR_WORKER_MESSAGE_BACKING_NOT_ATTACHED" });
      }
      const message = messagePacket(state.queue.shift()).data;
      port.#maybeClose();
      return { message };
    }
    static #receivePacket(port: MessagePort, kind: string, sequence: number, graph: unknown, defer = false) {
      const state = port.#state;
      if (!state || state.phase === "closed") return;
      if (kind === "port-close") {
        // A broker terminal can count fewer packets than the lane carried: take the lane's first.
        MessagePort.#drainLane(port, true);
        state.peerClosing = Math.max(state.peerClosing ?? 0, sequence); port.#accept(); return;
      }
      if (sequence < state.received) return;
      try {
        const value = record(graph);
        if (!Array.isArray(value.nodes) || typeof value.root !== "number") throw new Error("Invalid graph");
        state.pending.set(sequence, graph as Graph);
        if (!defer) port.#accept();
      } catch (error) { internal.realTimers.setImmediate(() => port.dispatchEvent(new MessageEvent("messageerror", { data: error }))); }
    }
    #accept() {
      const state = this.#value();
      this.#attachmentWait?.(); this.#attachmentWait = null;
      while (this.#acceptNext(state)) { /* Keep contiguous messages in sequence order. */ }
      this.#schedule();
      this.#maybeClose();
    }
    #acceptNext(state: PortState): boolean {
      const graph = state.pending.get(state.received);
      if (!graph || state.phase === "closed" || state.phase === "closing" && (state.lane !== null || state.group !== null)) return false;
      // A graph that failed earlier still has ends to close, or this call comes from inside
      // another graph's decoding: nothing new is taken until that one is settled.
      if (groupLanes && !receivedSettled()) return false;
      try {
        this.#attachmentWait = codec.wait(graph, () => this.#retryAttachments());
        if (this.#attachmentWait) return false;
        if (groupLanes) receiving.graph = graph;
        const decoded = decodeReceived(graph);
        if (!decoded) { receiving.graph = null; return false; }
        state.queue.push(decoded);
        receiving.graph = null;
      } catch (error) {
        // The message is lost, and what it carried goes with it, now or on a later step.
        if (receiving.graph === graph) { receiving.failed = true; receivedSettled(); }
        internal.realTimers.setImmediate(() => this.dispatchEvent(new MessageEvent("messageerror", { data: error })));
      }
      state.pending.delete(state.received++);
      return true;
    }
    #retryAttachments() {
      if (this.#state?.phase !== "open") return;
      this.#accept();
    }
    /**
     * The pump's pass over a port: frames that waited for an attachment are decoded, and
     * delivery that could not be queued when it was due is queued. True while delivery is still
     * owed, so the loop steps again instead of sleeping on a queue nothing will deliver.
     */
    static #retry(port: MessagePort): boolean {
      const state = port.#state;
      if (state?.phase !== "open") return false;
      try {
        if (state.pending.size && !port.#attachmentWait) port.#accept();
        else port.#schedule();
      } catch { /* still owed */ }
      return state.started && !state.scheduled && !state.batch && state.queue.length > 0;
    }
    #maybeClose() {
      const state = this.#state;
      if (!state || state.phase !== "open" || state.peerClosing === null || state.received < state.peerClosing) return;
      if (state.queue.length || state.pending.size || state.scheduled || state.batch) return;
      // A broker close can count fewer frames than the lane holds: wait until the lane says done.
      if (state.group && (!state.group.terminal || state.group.backlog)) return;
      this.#disconnect();
    }
    static #sent(port: MessagePort) { return port.#state?.sent || 0; }
    static #received(port: MessagePort) { return port.#state?.received || 0; }
    static #drained(port: MessagePort) { return !port.#state || !port.#state.queue.length && !port.#state.pending.size && !port.#state.scheduled && !port.#state.batch; }
    static #isClosed(port: MessagePort) { return !port.#state || port.#state.phase !== "open"; }
    get onmessage() { return this.#onmessage; }
    set onmessage(listener: ((event: MessageEvent) => unknown) | null) {
      this.#onmessage = typeof listener === "function" ? listener : null;
      if (this.#onmessage) { this.start(); this.ref(); }
      else if (!this.#hasMessageListeners()) this.unref();
    }
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      super.addEventListener(type, listener, options);
      if (type !== "message" || !listener) return;
      const captures = this.#webListeners.get(listener) || new Set<boolean>();
      captures.add(typeof options === "boolean" ? options : Boolean(options?.capture));
      this.#webListeners.set(listener, captures); this.start(); this.ref();
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
      super.removeEventListener(type, listener, options);
      if (type !== "message" || !listener) return;
      const captures = this.#webListeners.get(listener);
      captures?.delete(typeof options === "boolean" ? options : Boolean(options?.capture));
      if (!captures?.size) this.#webListeners.delete(listener);
      if (!this.#hasMessageListeners()) this.unref();
    }
    #hasMessageListeners() { return this.#onmessage !== null || this.#webListeners.size > 0 || this.listenerCount("message") > 0; }
    postMessage(value: unknown, transfer?: unknown) {
      if (!arguments.length) throw Object.assign(new TypeError("Not enough arguments to MessagePort.postMessage"), { code: "ERR_MISSING_ARGS" });
      settlePosts();
      const state = this.#state;
      if (!state || state.phase !== "open" || !state.peer) return;
      const other = localPorts.get(state.peer);
      const lane = other ? null : state.lane;
      const group = other ? null : state.group;
      // Refuse before preparing: past this point only plan.commit may fail, and it aborts the plan.
      if (lane && internal.sharedObjects?.routes?.retired(state.peer)) throw cloneError("MessagePort peer is closed");
      // Every separation of a group engine's channel creates its lane, so a port with neither
      // lane nor local peer had a local peer that has closed: the message is dropped.
      if (groupLanes && !other && !group) return;
      const list = transfers(transfer);
      const packet = { data: value, ports: list.filter(item => item instanceof MessagePort) };
      if (!group) { this.#postDirect(state, other, packet, list); return; }
      const call = beginPost(state, group.io, state.peer, packet, list);
      // The post commits here or not at all (see GroupPost). This call is the last statement,
      // outside any `try`, and nothing may be added after it: `scripts/worker-post-shape.test.ts`.
      internal.native.transferArrayBuffers(call[0], call[1], call[2], call[3], call[4], call[5], call[6]);
    }
    /** A post to a peer in this thread, or over the broker or its lane: every case but a group lane. */
    #postDirect(state: PortState, other: MessagePort | undefined, packet: unknown, list: unknown[]) {
      const plan = codec.prepare(packet, list, [state.id, state.peer!]);
      const sequence = state.sent;
      // The lane frame becomes visible only after transfers and detachment commit.
      const staged: { frame: { commit(): boolean | void; abort(): void } | null } = { frame: null };
      try { plan.commit(() => { staged.frame = this.#stagePacket(plan.graph, sequence, other); }, !other && state.lane ? state.peer! : undefined); }
      catch (error) { staged.frame?.abort(); throw error; }
      staged.frame?.commit();
      state.sent++;
      if (!other) return;
      restoringLocally = Boolean(internal.sharedObjects?.routes?.enabled);
      try { portOps.receivePacket(other, "port-data", sequence, plan.graph); }
      finally { restoringLocally = false; }
    }

    /**
     * Queues the delivery of what is in the queue. Whether delivery is owed is read from the
     * port's state alone (open, started, messages queued, no batch, no callback known), so a
     * call that fails here leaves the debt in place: the caller's retry, the next message or the
     * loop's next pump (`retry`) queues it then.
     */
    #schedule() {
      const state = this.#state;
      if (!state || state.phase !== "open" || !state.started || state.scheduled || state.batch || !state.queue.length) return;
      const turn = ++state.turn;
      internal.realTimers.setImmediate(() => { if (state.turn === turn) this.#deliver(state); });
      state.scheduled = turn;
    }
    #deliver(state: PortState) {
      state.scheduled = 0;
      if (this.#state !== state || state.phase !== "open" || !state.started || !state.queue.length) return;
      const batch = { queue: state.queue, remaining: state.queue.length };
      state.batch = batch;
      this.#deliverBatch(state, batch);
    }
    /**
     * A delivery step that finds the port's state taken off it stops the batch for good. The
     * port has moved, or a post that carried it is about to be rolled back: `restore` then
     * schedules the messages still queued, in order, and none is delivered twice because each
     * left the queue as it was dispatched. A batch left set here would block that for ever.
     */
    #stopBatch(state: PortState) { state.batch = null; state.scheduled = 0; }
    #deliverBatch(state: PortState, batch: DeliveryBatch) {
      if (this.#state !== state) { this.#stopBatch(state); return; }
      state.scheduled = 0;
      if (!batch.remaining || !batch.queue.length) { this.#continueBatch(state, batch); return; }
      batch.remaining--;
      const packet = messagePacket(batch.queue.shift());
      try { this.dispatchEvent(messageEvent(packet.data, packet.ports)); }
      finally { this.#continueBatch(state, batch); }
    }
    #continueBatch(state: PortState, batch: DeliveryBatch) {
      if (this.#state !== state) { this.#stopBatch(state); return; }
      if (!batch.remaining || !batch.queue.length) {
        state.batch = null;
        if (state.phase === "closing") { internal.realTimers.setImmediate(() => this.#finishLocalClose(state)); return; }
        this.#schedule(); this.#maybeClose(); return;
      }
      const turn = ++state.turn;
      try { queueMicrotask(() => { if (state.turn === turn) this.#deliverBatch(state, batch); }); }
      catch (error) {
        // A batch with no continuation would hold the queue for ever. It ends here, a callback
        // the failed call may still have queued is overtaken, and the rest is owed as above.
        state.turn++; state.batch = null;
        throw error;
      }
      state.scheduled = turn;
    }
    // Each of these first settles earlier posts: a post that was refused beyond its own cleanup
    // has left this port detached or counted, and is rolled back before the port is used.
    start() { settlePosts(); if (this.#state) { this.#state.started = true; this.#schedule(); } }
    // A port's state is in the keepalive set exactly while the port is referenced.
    ref() { settlePosts(); if (this.#state?.phase === "open") internal.messagePortRefs.add(this.#state); }
    unref() { settlePosts(); if (this.#state) internal.messagePortRefs.delete(this.#state); }
    hasRef() { settlePosts(); return this.#state ? internal.messagePortRefs.has(this.#state) : false; }
    close(callback?: () => void) {
      settlePosts();
      if (typeof callback === "function") this.once("close", callback);
      this.#beginClose();
    }
    #beginClose() {
      const state = this.#state;
      if (!state || state.phase !== "open") return;
      state.phase = "closing";
      state.lane?.io.close();
      // Stop reading for good: later posts are discarded, and every port carried in an unread
      // frame closes through the ledger, with no frame parsed.
      state.group?.io.closeRead();
      this.#attachmentWait?.(); this.#attachmentWait = null;
      for (const graph of state.pending.values()) discardPendingTransfers(graph);
      MessagePort.#closeQueuedPorts(state.queue);
      state.queue = []; state.pending.clear(); this.unref();
      if (!state.batch) internal.realTimers.setImmediate(() => this.#finishLocalClose(state));
    }
    static #closeQueuedPorts(queue: unknown[]) {
      for (const value of queue) {
        for (const port of messagePacket(value).ports) port.#beginClose();
      }
    }
    #finishLocalClose(state: PortState) {
      if (this.#state !== state || state.phase === "closed") return;
      if (state.peer) {
        const other = localPorts.get(state.peer);
        if (other) portOps.receivePacket(other, "port-close", state.sent, undefined);
        else if (!this.#laneClose(state.sent)) root({ kind: "port-close", id: state.peer, from: state.id, sequence: state.sent });
      }
      this.#disconnect();
    }
    #disconnect() {
      const state = this.#value();
      if (state.phase === "closed") return;
      state.phase = "closed";
      this.#attachmentWait?.(); this.#attachmentWait = null;
      this.#closeLane(true);
      state.queue = []; state.pending.clear(); this.unref(); localPorts.delete(state.id);
      root({ kind: "closed", id: state.id });
      internal.realTimers.setImmediate(() => this.#finishClose(state));
    }
    #finishClose(state: PortState) {
      if (this.#state !== state) return;
      this.dispatchEvent(new Event("close"));
    }
    on(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.on.call(this, event, listener);
      if (event === "message") { this.start(); this.ref(); }
      return this;
    }
    addListener(event: string | symbol, listener: BunWasm.EventListener) { return this.on(event, listener); }
    once(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.once.call(this, event, listener);
      return this;
    }
    off(event: string | symbol, listener: BunWasm.EventListener) { return this.removeListener(event, listener); }
    removeListener(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.removeListener.call(this, event, listener);
      if (event === "message" && !this.#hasMessageListeners()) this.unref();
      return this;
    }
    removeAllListeners(event?: string | symbol) {
      if (arguments.length) EventEmitter.prototype.removeAllListeners.call(this, event);
      else EventEmitter.prototype.removeAllListeners.call(this);
      if (!this.#hasMessageListeners()) this.unref();
      return this;
    }
    emit(event: string | symbol, ...args: unknown[]) { return EventEmitter.prototype.emit.call(this, event, ...args); }
    listenerCount(event: string | symbol) { return EventEmitter.prototype.listenerCount.call(this, event); }
    listeners(event: string | symbol) { return EventEmitter.prototype.listeners.call(this, event); }
    rawListeners(event: string | symbol) { return EventEmitter.prototype.rawListeners.call(this, event); }
    eventNames() { return EventEmitter.prototype.eventNames.call(this); }
    getMaxListeners() { return EventEmitter.prototype.getMaxListeners.call(this); }
    setMaxListeners(count: number) { EventEmitter.prototype.setMaxListeners.call(this, count); return this; }
    prependListener(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.prependListener.call(this, event, listener);
      if (event === "message") { this.start(); this.ref(); }
      return this;
    }
    prependOnceListener(event: string | symbol, listener: BunWasm.EventListener) {
      EventEmitter.prototype.prependOnceListener.call(this, event, listener);
      return this;
    }
    static get internals() {
      return { pair: MessagePort.#pair, restore: MessagePort.#restore, activate: MessagePort.#activate,
        prepare: MessagePort.#prepare, retry: MessagePort.#retry, discard: MessagePort.#discard, receive: MessagePort.#receive, drainLane: (port: MessagePort) => MessagePort.#drainLane(port), receivePacket: MessagePort.#receivePacket,
        isClosed: MessagePort.#isClosed, drained: MessagePort.#drained, sent: MessagePort.#sent, received: MessagePort.#received };
    }
    get [Symbol.toStringTag]() { return "MessagePort"; }
  }
  const portOps = MessagePort.internals;
  internal.sharedObjects?.routes?.onCredit(() => internal.realTimers.setImmediate(pump));
  Reflect.deleteProperty(MessagePort, "internals");
  class MessageChannel {
    readonly port1: MessagePort; readonly port2: MessagePort;
    constructor() { [this.port1, this.port2] = portOps.pair(); }
  }
  const PublicMessagePort = new Proxy(MessagePort, {
    apply() { throw Object.assign(new TypeError("Illegal constructor"), { code: "ERR_CONSTRUCT_CALL_INVALID" }); },
  });
  const PublicMessageChannel = new Proxy(MessageChannel, {
    apply() { throw Object.assign(new TypeError("Cannot call a class constructor without new"), { code: "ERR_CONSTRUCT_CALL_REQUIRED" }); },
  });
  Object.defineProperty(MessagePort.prototype, "constructor", { value: PublicMessagePort, writable: true, configurable: true });
  Object.defineProperty(MessageChannel.prototype, "constructor", { value: PublicMessageChannel, writable: true, configurable: true });
  const codecHooks: BunWasm.WorkerCodecHooks = {
    isPort: value => value instanceof MessagePort,
    prepare: portOps.prepare,
    restore: portOps.restore,
    activate: portOps.activate,
    groupLanes,
  };
  const strictCodec = internal.require("worker_codec").create(codecHooks);
  const codec = internal.require("worker_codec").create({ ...codecHooks, sharedObjects: internal.sharedObjects });
  internal.isMessagePort = value => value instanceof MessagePort;
  internal.clonePorts = (value, options) => strictCodec.decode(strictCodec.encode(value, transfers(options)));
  internal.workerErrorData = encodeWorkerError;

  class BroadcastChannel extends EventTarget {
    readonly name: string;
    #closed = false; #queue: unknown[] = [];
    onmessage: ((event: MessageEvent) => unknown) | null = null;
    onmessageerror: ((event: MessageEvent) => unknown) | null = null;
    constructor(name: string) {
      super();
      if (!arguments.length) throw new TypeError("BroadcastChannel requires a name");
      this.name = String(name);
      const peers = channels.get(this.name) || new Set<BroadcastChannel>();
      peers.add(this); channels.set(this.name, peers); internal.messagePortRefs.add(this);
    }
    static receive(channel: BroadcastChannel, value: unknown) {
      if (channel.#closed) return;
      channel.#queue.push(value); internal.realTimers.setImmediate(() => channel.#deliver());
    }
    postMessage(value: unknown) {
      if (this.#closed) throw new DOMException("BroadcastChannel is closed.", "InvalidStateError");
      if (!arguments.length) throw new TypeError("postMessage requires a message");
      const message = clone(value);
      for (const peer of channels.get(this.name) || []) if (peer !== this) BroadcastChannel.receive(peer, clone(message));
      if (route.length || children.size) root({ kind: "broadcast", name: this.name, graph: strictCodec.encode(value), source: route });
    }
    #deliver() { if (!this.#closed && this.#queue.length) this.dispatchEvent(messageEvent(this.#queue.shift())); }
    close() {
      if (this.#closed) return;
      this.#closed = true; this.unref(); this.#queue.length = 0;
      const peers = channels.get(this.name); peers?.delete(this);
      if (!peers?.size) channels.delete(this.name);
    }
    ref() { if (!this.#closed) internal.messagePortRefs.add(this); return this; }
    unref() { internal.messagePortRefs.delete(this); return this; }
    get [Symbol.toStringTag]() { return "BroadcastChannel"; }
  }

  function limits(value: unknown): BunWasm.WorkerLimits {
    if (value === undefined) return {};
    const input = record(value);
    const result: BunWasm.WorkerLimits = {};
    for (const key of ["maxOldGenerationSizeMb", "maxYoungGenerationSizeMb", "codeRangeSizeMb", "stackSizeMb"] as const) {
      const limit = input[key];
      if (limit === undefined) continue;
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) throw invalidArgument(`resourceLimits.${key}`);
      result[key] = limit;
    }
    return result;
  }
  function entry(filename: unknown, options: Record<string, unknown>) {
    if (options.eval) {
      if (typeof filename !== "string") throw Object.assign(new TypeError("options.eval must be false when filename is not a string"), { code: "ERR_INVALID_ARG_VALUE" });
      return { argv: ["-e", filename], name: "[worker eval]" };
    }
    if (filename instanceof URL) {
      if (filename.protocol === "data:") {
        const comma = filename.pathname.indexOf(",");
        const source = filename.pathname.slice(0, comma).endsWith(";base64") ? new TextDecoder().decode(native.base64Decode(filename.pathname.slice(comma + 1))) : decodeURIComponent(filename.pathname.slice(comma + 1));
        return { argv: ["-e", source], name: filename.href };
      }
      filename = internal.require("node_url").fileURLToPath(filename);
    }
    if (typeof filename !== "string") throw invalidArgument("filename");
    if (!/^(\/|\.\.?\/)/.test(filename)) {
      const hint = filename.startsWith("file:") ? " Wrap file:// URLs with `new URL`." : filename.startsWith("data:") ? " Wrap data: URLs with `new URL`." : "";
      throw Object.assign(new TypeError("Worker filename must be absolute or begin with './' or '../'." + hint), { code: "ERR_WORKER_PATH" });
    }
    const path = internal.require("path").resolve(process.cwd(), filename);
    if (!options._web && !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) throw Object.assign(new TypeError("Unsupported worker file extension"), { code: "ERR_WORKER_UNSUPPORTED_EXTENSION" });
    // `--` marks a file operand for both executables a process can be started as: `bun`, and
    // `node` (whose operands are always files, so `run` would be a module name there).
    return { argv: ["--", path], name: path };
  }
  function webEntry(target: { argv: string[]; name: string }, web: BunWasm.WebWorkerOptions) {
    if (target.argv[0] === "--") return target;
    const preloads = web.preload.map(path => `await import(${JSON.stringify(path)});`).join("\n");
    return { argv: ["-e", preloads + "\n;import.meta.__bunwasm_workerEntry?.();\n" + target.argv[1]], name: target.name };
  }
  type ExecOption = { kind: "require"; value: string } | { kind: "flag"; value: string };
  function execArguments(value: unknown) {
    const argv = value === undefined ? process.execArgv.slice() : value;
    if (!Array.isArray(argv) || !argv.every(arg => typeof arg === "string")) throw invalidArgument("execArgv");
    const conditions: string[] = [];
    const options: ExecOption[] = [];
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (["--no-warnings", "--no-deprecation", "--expose-gc", "--experimental-strip-types"].includes(arg)) { options.push({ kind: "flag", value: arg }); continue; }
      if (arg.startsWith("--require=")) { options.push({ kind: "require", value: arg.slice(10) }); continue; }
      if (arg.startsWith("--conditions=")) { conditions.push(arg); continue; }
      if (arg === "--conditions" && index + 1 < argv.length) { conditions.push(arg, argv[++index]); continue; }
      if ((arg === "--require" || arg === "-r") && index + 1 < argv.length) { options.push({ kind: "require", value: argv[++index] }); continue; }
      // Like Bun, flags the runtime does not interpret (--enable-source-maps, --inspect, ...)
      // still start the worker and stay in its process.execArgv.
    }
    return { argv, conditions, options };
  }
  class Worker extends EventEmitter {
    readonly stdout: BunWasm.WorkerReadable;
    readonly stderr: BunWasm.WorkerReadable;
    readonly stdin: BunWasm.WorkerWritable | null;
    readonly resourceLimits: BunWasm.WorkerLimits;
    #id: number; #path: Route; #port: MessagePort; #channel: BunWasm.WorkerChannel;
    #child: BunWasm.WorkerChild; #code: number | null = null; #exited = false; #error = false; #graceful = false; #expectedMessages = 0;
    #finishing = false; #scheduled = false; #termination: Promise<number> | null = null; #drained: Promise<unknown>;
    /** The child's ledger cell: custody of its `workerData` ports until it starts. */
    #cell: BunWasm.LaneCell | null = null;
    constructor(filename: unknown, rawOptions?: unknown) {
      super();
      const options = rawOptions == null ? {} : record(rawOptions);
      const requested = entry(filename, options);
      const web = webOptions(options._web);
      const target = web ? webEntry(requested, web) : requested;
      if (options.argv !== undefined && !Array.isArray(options.argv)) throw invalidArgument("argv");
      const argv = options.argv === undefined ? [] : Array.from(options.argv as unknown[], String);
      const exec = execArguments(options.execArgv);
      this.resourceLimits = limits(options.resourceLimits);
      this.#id = nextWorker++;
      this.#path = route.concat([this.#id]);
      const id = this.#path.reduce((parent, counter) => (parent + counter) * (parent + counter + 1) / 2 + counter + 1, 0);
      if (!Number.isSafeInteger(id)) throw new RangeError("Worker thread identifier exhausted");
      const env: Record<string, string> = {};
      const sourceEnv = options.env === undefined || options.env === SHARE_ENV ? process.env : record(options.env);
      for (const [key, value] of Object.entries(sourceEnv)) if (value !== undefined) env[key] = String(value);
      if (this.resourceLimits.stackSizeMb) env.BUN_WASM_STACK_KIB = String(Math.max(16, Math.min(Number(env.BUN_WASM_STACK_KIB || 4096), this.resourceLimits.stackSizeMb * 1024)));
      const [publicPort, childPort] = portOps.pair();
      this.#port = publicPort;
      let transferPlan: ReturnType<BunWasm.WorkerCodec["prepare"]>;
      let cell: BunWasm.LaneCell | null = null;
      try {
        cell = groupLanes ? groupLanes.cell() : null;
        transferPlan = codec.prepare([options.workerData, Array.from(environmentData), childPort], transfers(options.transferList).concat([childPort]), [], cell ? { kind: "cell", cell } : undefined);
      } catch (error) { if (cell) groupLanes?.exited(cell); publicPort.close(); childPort.close(); throw error; }
      this.#cell = cell;
      const graph = transferPlan.graph;
      const group = options.env === SHARE_ENV ? envGroup : routeKey(this.#path);
      // The group's ledger exists before the first worker is reserved; every descendant inherits it.
      const lanes = cell && groupLanes ? { ledger: groupLanes.ledger(), cell } : undefined;
      env.BUNWASM_WORKER_INIT = JSON.stringify({ route: this.#path, envGroup: group, argv: [process.execPath, target.name].concat(argv), execArgv: exec.argv, graph, resourceLimits: this.resourceLimits, web, lanes });
      const memoryLimitMb = (this.resourceLimits.maxOldGenerationSizeMb || 0) + (this.resourceLimits.maxYoungGenerationSizeMb || 0);
      let child: BunWasm.WorkerChild;
      try { child = internal.require("spawn").spawnWorker([process.execPath].concat(exec.conditions, target.argv, argv), {
        env, cwd: process.cwd(), stdin: options.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe",
        maxBuffer: Infinity,
      }, { resourceLimits: this.resourceLimits, memoryLimitMb: memoryLimitMb ? Math.ceil(memoryLimitMb) : undefined }); } catch (error) { transferPlan.abort(); if (cell) groupLanes?.exited(cell); publicPort.close(); childPort.close(); throw error; }
      this.#child = child;
      let control: BunWasm.WorkerChannel | null = null;
      try {
        control = internal.require("worker_channel").open(child._workerChannel.input, child._workerChannel.output);
        this.#channel = control;
        transferPlan.commit();
        children.set(this.#id, { ref: true, send: frame => { if (!this.#exited) this.#channel.send(frame); }, pump: () => this.#pump(), watch: () => this.#channel.subscriptions(), event: frame => this.#event(frame) });
        root({ kind: "member", path: this.#path, group });
        if (!route.length) claimTransferred(graph, this.#path);
        else root({ kind: "claim", graph, owner: this.#path });
        const io = internal.require("worker_stdio");
        const out = io.readable(child.stdout); const err = io.readable(child.stderr);
        this.stdout = out.stream; this.stderr = err.stream;
        this.stdin = child.stdin ? io.writable(child.stdin) : null;
        if (!options.stdout) this.stdout.pipe(process.stdout);
        if (!options.stderr) this.stderr.pipe(process.stderr);
        this.#drained = Promise.all([out.drained, err.drained]);
        publicPort.on("message", value => this.emit("message", value));
        if (web) EventTarget.prototype.addEventListener.call(publicPort, "message", event => {
          if (event instanceof MessageEvent) this.emit("_webmessage", webMessageEvent(event));
        });
        publicPort.on("messageerror", error => this.emit("messageerror", error)); publicPort.unref();
        child.exited.then(code => this.#settled(code), error => { this.#settled(1); this.#error = true; this.emit("error", error); });
      } catch (error) {
        transferPlan.abort();
        children.delete(this.#id);
        if (cell) groupLanes?.exited(cell);
        root({ kind: "gone", path: this.#path });
        publicPort.close(); childPort.close(); control?.close();
        child._abortWorker();
        throw error;
      }
    }
    #settled(code: number) { this.#code = code; this.#schedule(); }
    #schedule() {
      if (this.#scheduled || this.#exited) return;
      this.#scheduled = true;
      internal.realTimers.setImmediate(() => { this.#scheduled = false; this.#pump(); });
    }
    get threadId() { return this.#exited ? -1 : this.#path.reduce((parent, counter) => (parent + counter) * (parent + counter + 1) / 2 + counter + 1, 0); }
    postMessage(value: unknown, transfer?: unknown) { this.#port.postMessage(value, transfer); }
    ref() { this.#child.ref(); const actor = children.get(this.#id); if (actor) actor.ref = true; return this; }
    unref() { this.#child.unref(); const actor = children.get(this.#id); if (actor) actor.ref = false; return this; }
    terminate() {
      if (this.#exited) return Promise.resolve(undefined);
      if (this.#termination) return this.#termination;
      this.ref();
      this.#termination = new Promise(resolve => this.once("exit", code => resolve(Number(code))));
      this.#child.kill(9); return this.#termination;
    }
    #event(frame: Record<string, unknown>) {
      if (frame.kind === "exiting") {
        if (typeof frame.messages !== "number" || !Number.isSafeInteger(frame.messages) || frame.messages < 0) throw new Error("Invalid worker exit sequence");
        this.#graceful = true; this.#expectedMessages = frame.messages; return;
      }
      if (frame.kind === "online") { internal.realTimers.setImmediate(() => this.emit("online")); return; }
      if (frame.kind === "error") {
        this.#error = true;
        const error = strictCodec.decode(frame.graph);
        if (error instanceof Error && typeof frame.code === "string") Object.assign(error, { code: frame.code });
        internal.realTimers.setImmediate(() => this.emit("error", error)); return;
      }
      throw new Error("Unknown worker lifecycle event");
    }
    #pump() {
      if (this.#exited) return false;
      let progress = false;
      try { progress = this.#channel.pump(incoming); }
      catch (error) { this.#channel.close(); this.#child.kill(9); internal.realTimers.setImmediate(() => this.emit("messageerror", error)); }
      if (this.#code !== null && !this.#channel.ended) this.#schedule();
      if (this.#code !== null && this.#channel.ended && !this.#finishing) {
        this.#finishing = true;
        this.#drained.then(() => internal.realTimers.setImmediate(() => this.#finish()));
        progress = true;
      }
      return progress;
    }
    #finish() {
      if (!portOps.drained(this.#port) || portOps.received(this.#port) < this.#expectedMessages) { internal.realTimers.setImmediate(() => this.#finish()); return; }
      this.#exited = true;
      this.#port.close(); this.#channel.close(); this.#child._finishWorker(); children.delete(this.#id);
      // The host reported the exit: the child's lane ends close now, its storage once the host releases it.
      if (this.#cell) groupLanes?.exited(this.#cell);
      root({ kind: "gone", path: this.#path });
      // This runs on its own turn of the loop, never inside a synchronous receive, and it may
      // be the loop's last: the sweep and the retirement the exit owes happen here, not at a
      // later step that an otherwise idle guest would never take.
      laneHousekeeping();
      const code = this.#termination ? 1 : this.#code ?? 1;
      if (code !== 0 && this.#child.signalCode === null && !this.#termination && !this.#error && !this.#graceful) this.emit("error", new Error(`Worker exited with code ${code}`));
      this.emit("exit", code);
    }
  }
  const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
  function receiveMessageOnPort(port: unknown) {
    settlePosts();
    pump();
    if (port instanceof MessagePort) return portOps.receive(port);
    if (port instanceof BroadcastChannel) return undefined;
    throw invalidPort();
  }
  function moveMessagePortToContext(port: unknown, _context: unknown): never {
    if (!(port instanceof MessagePort)) throw invalidPort();
    settlePosts();
    if (portOps.isClosed(port)) throw Object.assign(new Error("Cannot send data on closed MessagePort"), { code: "ERR_CLOSED_MESSAGE_PORT" });
    throw Object.assign(new Error("VM contexts are not supported in bun-wasm"), { code: "ERR_NOT_SUPPORTED_IN_WASM" });
  }
  function isBuildError(error: unknown): error is Error {
    return error instanceof Error && error.name === "BuildError" && "__bunwasmFormatted" in error;
  }
  function encodeWorkerError(reported: unknown): BunWasm.WorkerErrorData {
    let error = isBuildError(reported) ? new SyntaxError(reported.message) : reported;
    let graph: Graph;
    try { graph = strictCodec.encode(error); }
    catch {
      error = Object.assign(new Error("Cannot serialize worker error"), { code: "ERR_WORKER_UNSERIALIZABLE_ERROR" });
      graph = strictCodec.encode(error);
    }
    let code: string | undefined;
    if (error && typeof error === "object") {
      try {
        const value = Reflect.get(error, "code");
        if (typeof value === "string") code = value;
      } catch {}
    }
    return { graph, code };
  }

  function initialize() {
    if (!config || initialized) return;
    const exec = execArguments(config.execArgv);
    initialized = true;
    delete process.env.BUNWASM_WORKER_INIT;
    delete process.env.BUNWASM_WORKER_CONTROL;
    // The parent bound its two control pipe ends and published their numbers in the environment.
    const control = JSON.parse(controlFds || "{}");
    if (!Number.isInteger(control.input) || !Number.isInteger(control.output) || control.input < 3 || control.output < 3) throw new Error("Invalid worker control descriptors");
    parentChannel = internal.require("worker_channel").open(control.input, control.output);
    try {
      // Join the parent's lanes before decoding workerData, whose ports are in this worker's cell.
      if (config.lanes) {
        if (!groupLanes) throw new Error("Worker lanes need a shared-group engine");
        groupLanes.join(config.lanes.ledger, config.lanes.cell);
      }
      let startup: ReturnType<typeof deferredInitialization> | undefined;
      let notified = false;
      const cancel = codec.wait(config.graph, () => { notified = true; startup?.resume(); });
      if (!cancel) { initializeData(exec); return; }
      startup = deferredInitialization(cancel, () => initializeData(exec));
      internal.workerStartup = startup;
      if (notified) startup.resume();
    } catch (error) { parentChannel.close(); throw error; }
  }
  function deferredInitialization(cancelWait: () => void, hydrate: () => void) {
    let phase: "pending" | "settled" | "cancelled" = "pending";
    let resolveReady = () => {};
    let rejectReady = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    function resume() {
      if (phase !== "pending") return;
      phase = "settled";
      try { hydrate(); resolveReady(); }
      catch (error) { rejectReady(error); }
    }
    function cancel() {
      if (phase === "cancelled") return;
      const pending = phase === "pending";
      phase = "cancelled";
      cancelWait(); parentChannel?.close();
      if (pending) rejectReady(new Error("Worker initialization was cancelled"));
    }
    return { ready, resume, cancel };
  }
  function initializeData(exec: ReturnType<typeof execArguments>) {
    if (!config || !parentChannel) throw new Error("Missing worker initialization");
    const initial = codec.decode(config.graph);
    if (!Array.isArray(initial) || initial.length !== 3 || !(initial[2] instanceof MessagePort) || !Array.isArray(initial[1])) throw new Error("Invalid worker initial data");
    exports.workerData = initial[0]; parentPort = initial[2]; exports.parentPort = parentPort;
    for (const pair of initial[1]) if (Array.isArray(pair) && pair.length === 2) environmentData.set(pair[0], pair[1]);
    process.argv = config.argv; process.execArgv = config.execArgv;
    if (config.web) internal.require("bun").isMainThread = false;
    root({ kind: "member", path: route, group: envGroup });
    internal.workerExit = code => {
      // The count below must not include a post that was refused and not rolled back yet, and
      // what a committed post still owes goes out with the frames drained here.
      settleOwed();
      parentChannel?.send({ kind: "down", path: route.slice(0, -1), body: { kind: "exiting", child: route[route.length - 1], code, messages: parentPort ? portOps.sent(parentPort) : 0 } });
      parentChannel?.drain();
    };
    internal.workerError = reported => {
      const { graph, code } = encodeWorkerError(reported);
      parentChannel?.send({ kind: "down", path: route.slice(0, -1), body: { kind: "error", child: route[route.length - 1], graph, code } });
    };
    if (config.web) {
      internal.require("web_worker").initialize(parentPort, config.web, webMessageEvent);
      parentChannel.send({ kind: "down", path: route.slice(0, -1), body: { kind: "online", child: route[route.length - 1] } });
    }
    const requirePreload = internal.builtin("node:module").createRequire(process.cwd() + "/__worker_preload__.cjs");
    for (const option of exec.options) {
      if (option.kind === "require") { requirePreload(option.value); continue; }
      const arg = option.value;
      if (arg === "--expose-gc") Object.defineProperty(globalThis, "gc", { configurable: true, writable: true, value: () => native.gc() });
      if (arg === "--no-warnings") internal.workerNoWarnings = true;
      if (arg === "--no-deprecation") process.noDeprecation = true;
    }
    if (!config.web) parentChannel.send({ kind: "down", path: route.slice(0, -1), body: { kind: "online", child: route[route.length - 1] } });
  }
  const initialState: { parentPort: MessagePort | null; workerData: unknown } = { parentPort, workerData: null };
  const exports = Object.assign(initialState, {
    isMainThread: !config, threadId,
    resourceLimits: config?.resourceLimits || {}, SHARE_ENV, MessageChannel: PublicMessageChannel, MessagePort: PublicMessagePort, BroadcastChannel, Worker,
    markAsUntransferable, isMarkedAsUntransferable, moveMessagePortToContext, receiveMessageOnPort, initialize,
    getEnvironmentData(key: unknown) { return environmentData.get(key); },
    setEnvironmentData(key: unknown, value: unknown) { if (value === undefined) environmentData.delete(key); else environmentData.set(key, value); },
  });
  internal.require("net");
  internal.workerPump = pump;
  internal.workerEnvChange = (key, value) => { if (!applyingEnv) root({ kind: "env", source: route, group: envGroup, key, value }); };
  const waiter: BunWasm.IoWaiter = {
    // A post that still owes its records keeps the loop turning until a step has sent them.
    get ref() { return Boolean(posts.size || parentChannel && (parentChannel.pending || parentPort?.hasRef()) || Array.from(children.values()).some(child => child.ref)); },
    step() {
      const owed = posts.size;
      settleOwed();
      // The housekeeping is owed whatever the pump met: a failed drain must not hold back the
      // sweep or the retirement of closed lanes.
      try { return pump() || posts.size !== owed ? "progress" : false; }
      finally { laneHousekeeping(); }
    },
    // Every open control channel: the idle loop wakes for a frame from any of them.
    subscriptions() {
      const list = parentChannel ? [parentChannel.subscriptions()] : [];
      for (const child of children.values()) list.push(child.watch());
      return internal.concatBytes(list);
    },
    // This waiter is the only thing that pumps this thread's control channels, lanes and lane
    // housekeeping, so the loop never takes it out: a thread that handles a failed step keeps
    // all of them, and the next step takes up what the failed one left, such as a lane batch
    // the core kept or a frame still queued. Staying registered costs nothing after the
    // failure. Being put back would need a new set entry, which can fail in turn.
    permanent: true,
    // A failed step is this thread's uncaught error, and it is thrown on as one: the loop then
    // runs `uncaughtException` handlers, or reports it (a worker to its parent) and exits 1.
    fail(error) { throw error; },
  };
  internal.addIoWaiter(waiter);
  return exports;
})
