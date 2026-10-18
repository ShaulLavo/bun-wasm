(function (internal: BunWasm.Internal) {
  "use strict";
  type Route = BunWasm.WorkerRoute;
  type Graph = BunWasm.WorkerGraph;
  type Snapshot = BunWasm.PortSnapshot;
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
  const children = new Map<number, { ref: boolean; send(frame: unknown): void; pump(): boolean; watch(): Uint8Array; event(frame: Record<string, unknown>): void }>();
  const owners = new Map<string, { owner: Route | null; origin: Route; version: number; peer: string | null; sent: number; ready: boolean }>();
  const pending = new Map<string, Record<string, unknown>[]>();
  const members = new Map<string, { route: Route; group: string }>();
  let nextPort = 0;
  let nextWorker = 0;
  let applyingEnv = false;
  let initialized = false;
  let parentPort: MessagePort | null = null;
  let parentChannel: BunWasm.WorkerChannel | null = null;
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
      graph: value.graph, resourceLimits: limits(value.resourceLimits), web: webOptions(value.web) };
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
    if (route.length) { parentChannel?.send({ kind: "up", body }); return; }
    rootCommand(body);
  }
  function incoming(frame: unknown) {
    const value = record(frame);
    if (value.kind === "up") { root(record(value.body)); return; }
    if (value.kind === "down") { down(parseRoute(value.path), record(value.body)); return; }
    throw new Error("Unknown worker control frame");
  }
  function own(snapshot: Omit<Snapshot, "queue">, owner: Route | null, origin: Route, ready = true) {
    const previous = owners.get(snapshot.id);
    if (previous && previous.version > snapshot.version) return;
    owners.set(snapshot.id, { owner, origin, version: snapshot.version, peer: snapshot.peer, sent: snapshot.sent, ready });
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
      own(snapshotRecord(node[1]), owner, owner, false);
    }
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
      case "bind": own(snapshotRecord(body.snapshot), parseRoute(body.owner), parseRoute(body.owner)); return;
      case "moving": own(snapshotRecord(body.snapshot), null, parseRoute(body.origin), false); return;
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
          if (endpoint.peer) routePacket({ kind: "port-close", id: endpoint.peer, sequence: endpoint.sent });
          owners.delete(id); pending.delete(id);
        }
        return;
      }
      default: throw new Error("Unknown worker broker command");
    }
  }
  function direct(body: Record<string, unknown>) {
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
      for (const channel of channels.get(body.name) || []) BroadcastChannel.receive(channel, codec.decode(body.graph));
      return;
    }
    if (typeof body.child === "number") { children.get(body.child)?.event(body); return; }
    throw new Error("Unknown worker delivery");
  }
  function pump() {
    let progress = parentChannel?.pump(incoming) || false;
    for (const child of Array.from(children.values())) progress = child.pump() || progress;
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
    phase: "open" | "closing" | "closed";
    batch: DeliveryBatch | null;
    started: boolean; ref: boolean; scheduled: boolean;
  }
  class MessagePort extends EventTarget {
    #state: PortState | null;
    #webListeners = new Map<EventListenerOrEventListenerObject, Set<boolean>>();
    #onmessage: ((event: MessageEvent) => unknown) | null = null;
    onmessageerror: ((event: MessageEvent) => unknown) | null = null;
    constructor(key: object, snapshot?: Snapshot) {
      super();
      if (key !== token) throw new TypeError("Illegal constructor");
      const id = `${routeKey(route)}:${nextPort++}`;
      const value = snapshot || { id, peer: null, version: 0, sent: 0, received: 0, queue: [], pending: [], closing: null, closed: false };
      this.#state = { ...value, pending: new Map(value.pending), peerClosing: value.closing,
        phase: value.closed ? "closed" : "open", batch: null, started: false, ref: false, scheduled: false };
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
      first.#bind(); second.#bind(); return [first, second];
    }
    #value() { if (!this.#state) throw cloneError("MessagePort is detached"); return this.#state; }
    #snapshot(version = this.#value().version): Snapshot {
      const state = this.#value();
      return { id: state.id, peer: state.peer, version, sent: state.sent, received: state.received,
        queue: state.queue.slice(), pending: Array.from(state.pending), closing: state.peerClosing, closed: state.phase === "closed" };
    }
    #bind() { const { queue, ...snapshot } = this.#snapshot(); root({ kind: "bind", snapshot, owner: route }); }
    static #restore(snapshot: Snapshot) { return new MessagePort(token, snapshot); }
    static #activate(value: unknown) { if (!(value instanceof MessagePort)) throw invalidPort(); value.#bind(); value.#accept(); }
    static #prepare(value: unknown): BunWasm.PortTransfer {
      if (!(value instanceof MessagePort)) throw invalidPort();
      const state = value.#value();
      if (state.phase !== "open") throw cloneError("Cannot transfer a closed MessagePort");
      const snapshot = value.#snapshot(state.version + 1);
      return {
        snapshot,
        validate() { if (value.#state !== state || state.phase !== "open") throw cloneError("MessagePort changed during transfer"); },
        commit() {
          value.unref(); localPorts.delete(state.id); value.#state = null;
          const { queue, ...metadata } = snapshot;
          root({ kind: "moving", snapshot: metadata, origin: route });
        },
      };
    }
    static #receive(port: MessagePort) {
      if (!port.#state?.queue.length) return undefined;
      const message = messagePacket(port.#state.queue.shift()).data;
      port.#maybeClose();
      return { message };
    }
    static #receivePacket(port: MessagePort, kind: string, sequence: number, graph: unknown) {
      const state = port.#state;
      if (!state || state.phase === "closed") return;
      if (kind === "port-close") { state.peerClosing = sequence; port.#accept(); return; }
      if (sequence < state.received) return;
      try {
        const value = record(graph);
        if (!Array.isArray(value.nodes) || typeof value.root !== "number") throw new Error("Invalid graph");
        state.pending.set(sequence, graph as Graph);
        port.#accept();
      } catch (error) { internal.realTimers.setImmediate(() => port.dispatchEvent(new MessageEvent("messageerror", { data: error }))); }
    }
    #accept() {
      const state = this.#value();
      while (state.pending.has(state.received)) {
        const graph = state.pending.get(state.received);
        state.pending.delete(state.received++);
        state.queue.push(messagePacket(codec.decode(graph)));
      }
      this.#schedule();
      this.#maybeClose();
    }
    #maybeClose() {
      const state = this.#state;
      if (!state || state.phase !== "open" || state.peerClosing === null || state.received < state.peerClosing) return;
      if (state.queue.length || state.pending.size || state.scheduled || state.batch) return;
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
      const state = this.#state;
      if (!state || state.phase !== "open" || !state.peer) return;
      const list = transfers(transfer);
      const packet = { data: value, ports: list.filter(item => item instanceof MessagePort) };
      const graph = codec.encode(packet, list, [state.id, state.peer]);
      const sequence = state.sent++;
      const other = localPorts.get(state.peer);
      if (other) { portOps.receivePacket(other, "port-data", sequence, graph); return; }
      root({ kind: "port-data", id: state.peer, from: state.id, sequence, graph });
    }
    #schedule() {
      const state = this.#state;
      if (!state || state.phase !== "open" || !state.started || state.scheduled || state.batch || !state.queue.length) return;
      state.scheduled = true; internal.realTimers.setImmediate(() => this.#deliver(state));
    }
    #deliver(state: PortState) {
      state.scheduled = false;
      if (this.#state !== state || state.phase !== "open" || !state.started || !state.queue.length) return;
      const batch = { queue: state.queue, remaining: state.queue.length };
      state.batch = batch;
      this.#deliverBatch(state, batch);
    }
    #deliverBatch(state: PortState, batch: DeliveryBatch) {
      if (this.#state !== state) return;
      state.scheduled = false;
      if (!batch.remaining || !batch.queue.length) { this.#continueBatch(state, batch); return; }
      batch.remaining--;
      const packet = messagePacket(batch.queue.shift());
      try { this.dispatchEvent(messageEvent(packet.data, packet.ports)); }
      finally { this.#continueBatch(state, batch); }
    }
    #continueBatch(state: PortState, batch: DeliveryBatch) {
      if (this.#state !== state) return;
      if (!batch.remaining || !batch.queue.length) {
        state.batch = null;
        if (state.phase === "closing") { internal.realTimers.setImmediate(() => this.#finishLocalClose(state)); return; }
        this.#schedule(); this.#maybeClose(); return;
      }
      state.scheduled = true;
      queueMicrotask(() => this.#deliverBatch(state, batch));
    }
    start() { if (this.#state) { this.#state.started = true; this.#schedule(); } }
    ref() { if (this.#state?.phase === "open" && !this.#state.ref) { this.#state.ref = true; internal.messagePortRefs++; } }
    unref() { if (this.#state?.ref) { this.#state.ref = false; internal.messagePortRefs--; } }
    hasRef() { return this.#state?.ref || false; }
    close(callback?: () => void) {
      if (typeof callback === "function") this.once("close", callback);
      const state = this.#state;
      if (!state || state.phase !== "open") return;
      state.phase = "closing"; state.queue = []; state.pending.clear(); this.unref();
      if (!state.batch) internal.realTimers.setImmediate(() => this.#finishLocalClose(state));
    }
    #finishLocalClose(state: PortState) {
      if (this.#state !== state || state.phase === "closed") return;
      this.#disconnect();
      if (state.peer) {
        const other = localPorts.get(state.peer);
        if (other) portOps.receivePacket(other, "port-close", state.sent, undefined);
        else root({ kind: "port-close", id: state.peer, from: state.id, sequence: state.sent });
      }
    }
    #disconnect() {
      const state = this.#value();
      if (state.phase === "closed") return;
      state.phase = "closed"; state.queue = []; state.pending.clear(); this.unref(); localPorts.delete(state.id);
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
        prepare: MessagePort.#prepare, receive: MessagePort.#receive, receivePacket: MessagePort.#receivePacket,
        isClosed: MessagePort.#isClosed, drained: MessagePort.#drained, sent: MessagePort.#sent, received: MessagePort.#received };
    }
    get [Symbol.toStringTag]() { return "MessagePort"; }
  }
  const portOps = MessagePort.internals;
  Reflect.deleteProperty(MessagePort, "internals");
  class MessageChannel {
    readonly port1: MessagePort; readonly port2: MessagePort;
    constructor() { [this.port1, this.port2] = portOps.pair(); }
  }
  const codec = internal.require("worker_codec").create({
    isPort: value => value instanceof MessagePort,
    prepare: portOps.prepare,
    restore: portOps.restore,
    activate: portOps.activate,
  });
  internal.isMessagePort = value => value instanceof MessagePort;
  internal.clonePorts = (value, options) => codec.decode(codec.encode(value, transfers(options)));

  class BroadcastChannel extends EventTarget {
    readonly name: string;
    #closed = false; #ref = true; #queue: unknown[] = [];
    onmessage: ((event: MessageEvent) => unknown) | null = null;
    onmessageerror: ((event: MessageEvent) => unknown) | null = null;
    constructor(name: string) {
      super();
      if (!arguments.length) throw new TypeError("BroadcastChannel requires a name");
      this.name = String(name);
      const peers = channels.get(this.name) || new Set<BroadcastChannel>();
      peers.add(this); channels.set(this.name, peers); internal.messagePortRefs++;
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
      if (route.length || children.size) root({ kind: "broadcast", name: this.name, graph: codec.encode(value), source: route });
    }
    #deliver() { if (!this.#closed && this.#queue.length) this.dispatchEvent(messageEvent(this.#queue.shift())); }
    close() {
      if (this.#closed) return;
      this.#closed = true; this.unref(); this.#queue.length = 0;
      const peers = channels.get(this.name); peers?.delete(this);
      if (!peers?.size) channels.delete(this.name);
    }
    ref() { if (!this.#closed && !this.#ref) { this.#ref = true; internal.messagePortRefs++; } return this; }
    unref() { if (this.#ref) { this.#ref = false; internal.messagePortRefs--; } return this; }
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
    return { argv: ["run", path], name: path };
  }
  function webEntry(target: { argv: string[]; name: string }, web: BunWasm.WebWorkerOptions) {
    if (target.argv[0] === "run") return target;
    const preloads = web.preload.map(path => `await import(${JSON.stringify(path)});`).join("\n");
    return { argv: ["-e", preloads + "\n;import.meta.__bunwasm_workerEntry?.();\n" + target.argv[1]], name: target.name };
  }
  function execArguments(value: unknown) {
    if (value === undefined) return process.execArgv.slice();
    if (!Array.isArray(value) || !value.every(arg => typeof arg === "string")) throw invalidArgument("execArgv");
    for (let index = 0; index < value.length; index++) {
      const arg = value[index];
      if (["--no-warnings", "--expose-gc", "--experimental-strip-types"].includes(arg) || arg.startsWith("--require=")) continue;
      if ((arg === "--require" || arg === "-r") && index + 1 < value.length) { index++; continue; }
      throw Object.assign(new Error(`Invalid execArgv flag: ${arg}`), { code: "ERR_WORKER_INVALID_EXEC_ARGV" });
    }
    return value;
  }
  class Worker extends EventEmitter {
    readonly stdout: BunWasm.WorkerReadable;
    readonly stderr: BunWasm.WorkerReadable;
    readonly stdin: BunWasm.WorkerWritable | null;
    readonly resourceLimits: BunWasm.WorkerLimits;
    #id: number; #path: Route; #port: MessagePort; #channel: BunWasm.WorkerChannel;
    #child: BunWasm.WorkerChild; #code: number | null = null; #exited = false; #error = false; #graceful = false; #expectedMessages = 0;
    #finishing = false; #scheduled = false; #termination: Promise<number> | null = null; #drained: Promise<unknown>;
    constructor(filename: unknown, rawOptions?: unknown) {
      super();
      const options = rawOptions == null ? {} : record(rawOptions);
      const requested = entry(filename, options);
      const web = webOptions(options._web);
      const target = web ? webEntry(requested, web) : requested;
      if (options.argv !== undefined && !Array.isArray(options.argv)) throw invalidArgument("argv");
      const argv = options.argv === undefined ? [] : Array.from(options.argv as unknown[], String);
      const execArgv = execArguments(options.execArgv);
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
      try { transferPlan = codec.prepare([options.workerData, Array.from(environmentData), childPort], transfers(options.transferList).concat([childPort])); }
      catch (error) { publicPort.close(); childPort.close(); throw error; }
      const graph = transferPlan.graph;
      const group = options.env === SHARE_ENV ? envGroup : routeKey(this.#path);
      env.BUNWASM_WORKER_INIT = JSON.stringify({ route: this.#path, envGroup: group, argv: [process.execPath, target.name].concat(argv), execArgv, graph, resourceLimits: this.resourceLimits, web });
      const memoryLimitMb = (this.resourceLimits.maxOldGenerationSizeMb || 0) + (this.resourceLimits.maxYoungGenerationSizeMb || 0);
      let child: BunWasm.WorkerChild;
      try { child = internal.require("spawn").spawn([process.execPath].concat(target.argv, argv), {
        env, cwd: process.cwd(), stdin: options.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe",
        maxBuffer: Infinity,
        _worker: { resourceLimits: this.resourceLimits, memoryLimitMb: memoryLimitMb ? Math.ceil(memoryLimitMb) : undefined },
      }); } catch (error) { publicPort.close(); childPort.close(); throw error; }
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
        children.delete(this.#id);
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
        const error = codec.decode(frame.graph);
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
      root({ kind: "gone", path: this.#path });
      const code = this.#termination ? 1 : this.#code ?? 1;
      if (code !== 0 && this.#child.signalCode === null && !this.#termination && !this.#error && !this.#graceful) this.emit("error", new Error(`Worker exited with code ${code}`));
      this.emit("exit", code);
    }
  }
  const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
  function receiveMessageOnPort(port: unknown) {
    pump();
    if (port instanceof MessagePort) return portOps.receive(port);
    if (port instanceof BroadcastChannel) return undefined;
    throw invalidPort();
  }
  function moveMessagePortToContext(port: unknown, context: unknown): never {
    if (!(port instanceof MessagePort)) throw invalidPort();
    if (portOps.isClosed(port)) throw Object.assign(new Error("Cannot send data on closed MessagePort"), { code: "ERR_CLOSED_MESSAGE_PORT" });
    throw Object.assign(new Error("VM contexts are not supported in bun-wasm"), { code: "ERR_NOT_SUPPORTED_IN_WASM" });
  }
  function initialize() {
    if (!config || initialized) return;
    initialized = true;
    delete process.env.BUNWASM_WORKER_INIT;
    delete process.env.BUNWASM_WORKER_CONTROL;
    // The parent bound its two control pipe ends and published their numbers in the environment.
    const control = JSON.parse(controlFds || "{}");
    if (!Number.isInteger(control.input) || !Number.isInteger(control.output) || control.input < 3 || control.output < 3) throw new Error("Invalid worker control descriptors");
    parentChannel = internal.require("worker_channel").open(control.input, control.output);
    const initial = codec.decode(config.graph);
    if (!Array.isArray(initial) || initial.length !== 3 || !(initial[2] instanceof MessagePort) || !Array.isArray(initial[1])) throw new Error("Invalid worker initial data");
    exports.workerData = initial[0]; parentPort = initial[2]; exports.parentPort = parentPort;
    for (const pair of initial[1]) if (Array.isArray(pair) && pair.length === 2) environmentData.set(pair[0], pair[1]);
    process.argv = config.argv; process.execArgv = config.execArgv;
    if (config.web) internal.require("bun").isMainThread = false;
    root({ kind: "member", path: route, group: envGroup });
    internal.workerExit = code => {
      parentChannel?.send({ kind: "down", path: route.slice(0, -1), body: { kind: "exiting", child: route[route.length - 1], code, messages: parentPort ? portOps.sent(parentPort) : 0 } });
      parentChannel?.drain();
    };
    internal.workerError = error => {
      let graph: Graph;
      try { graph = codec.encode(error); }
      catch { graph = codec.encode(Object.assign(new Error("Cannot serialize worker error"), { code: "ERR_WORKER_UNSERIALIZABLE_ERROR" })); }
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      parentChannel?.send({ kind: "down", path: route.slice(0, -1), body: { kind: "error", child: route[route.length - 1], graph, code } });
    };
    if (config.web) {
      internal.require("web_worker").initialize(parentPort, config.web, webMessageEvent);
      parentChannel.send({ kind: "down", path: route.slice(0, -1), body: { kind: "online", child: route[route.length - 1] } });
    }
    const requirePreload = internal.builtin("node:module").createRequire(process.cwd() + "/__worker_preload__.cjs");
    for (let index = 0; index < config.execArgv.length; index++) {
      const arg = config.execArgv[index];
      if (arg === "--require" || arg === "-r") requirePreload(config.execArgv[++index]);
      if (arg.startsWith("--require=")) requirePreload(arg.slice(10));
      if (arg === "--expose-gc") Object.defineProperty(globalThis, "gc", { configurable: true, writable: true, value: () => native.gc() });
      if (arg === "--no-warnings") internal.workerNoWarnings = true;
    }
    if (!config.web) parentChannel.send({ kind: "down", path: route.slice(0, -1), body: { kind: "online", child: route[route.length - 1] } });
  }
  const initialState: { parentPort: MessagePort | null; workerData: unknown } = { parentPort, workerData: null };
  const exports = Object.assign(initialState, {
    isMainThread: !config, threadId,
    resourceLimits: config?.resourceLimits || {}, SHARE_ENV, MessageChannel, MessagePort, BroadcastChannel, Worker,
    markAsUntransferable, isMarkedAsUntransferable, moveMessagePortToContext, receiveMessageOnPort, initialize,
    getEnvironmentData(key: unknown) { return environmentData.get(key); },
    setEnvironmentData(key: unknown, value: unknown) { if (value === undefined) environmentData.delete(key); else environmentData.set(key, value); },
  });
  internal.require("net");
  internal.workerPump = pump;
  internal.workerEnvChange = (key, value) => { if (!applyingEnv) root({ kind: "env", source: route, group: envGroup, key, value }); };
  internal.addIoWaiter({
    get ref() { return Boolean(parentChannel && (parentChannel.pending || parentPort?.hasRef()) || Array.from(children.values()).some(child => child.ref)); },
    step() { return pump() ? "progress" : false; },
    // Every open control channel: the idle loop wakes for a frame from any of them.
    subscriptions() {
      const list = parentChannel ? [parentChannel.subscriptions()] : [];
      for (const child of children.values()) list.push(child.watch());
      return internal.concatBytes(list);
    },
    fail(error) { if (parentChannel) internal.workerError?.(error); },
  });
  return exports;
})
