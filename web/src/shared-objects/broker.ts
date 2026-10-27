import { messageData, sharedError, sharedObjectLimit, sharedRequest, sharedRouteBatch } from "./protocol.ts";
import { createSharedMailbox, requireSharedMailboxWake } from "./mailbox.ts";
import type { SharedAttachment, SharedPort, SharedReference, SharedRequest, SharedResponse, SharedRouteCommand } from "./protocol.ts";

interface Source { owner: string | null; peer: string | null; sent: number; version: number; }
interface Client { readonly id: string; port: SharedPort | null; mailbox: ReturnType<typeof createSharedMailbox> | null; outbox: ReturnType<typeof createSharedMailbox> | null; readonly held: Set<string>; readonly retired: Set<string>; readonly waiting: Map<string, SharedReference>; detach: () => void; readonly watches: (() => void)[]; readonly sources: Map<number, Map<string, Source>>; }
type RoutePacket = Extract<SharedRouteCommand, { kind: "port-data" | "port-close" }>;
interface Entry { readonly attachment: SharedAttachment; readonly publisher: string; readonly transaction: string; readonly holders: Set<string>; mailbox: boolean; revoked: boolean; }
export function createSharedObjectBroker() {
  requireSharedMailboxWake();
  const clients = new Map<string, Client>();
  const entries = new Map<string, Entry>();
  let disposed = false;
  interface Endpoint { owner: string | null; origin: string; expected: string | null; version: number; peer: string | null; sent: number; terminal?: Extract<SharedRouteCommand, { kind: "port-close" }>; }
  const routeOwners = new Map<string, Endpoint>();
  const registrations = new Map<string, { origin: string; command: Extract<SharedRouteCommand, { kind: "bind" | "moving" }> }>();
  const pendingRoutes: { origin: string; target: string; command: SharedRouteCommand }[] = [];
  const deferredBatches: { origin: string; commands: SharedRouteCommand[]; sources: Map<string, Source> }[] = [];
  const deliveries = new Map<string, { holder: string; origin: string; command: RoutePacket; returned: boolean }>();
  const deliveryLimit = sharedObjectLimit * 8;
  const pendingRouteLimit = sharedObjectLimit;
  function pendingSize() { return pendingRoutes.length + deferredBatches.length; }
  let draining = false;
  function send(client: Client, packet: SharedResponse) {
    if (!client.port) { closeClient(client); return; }
    try { client.port.postMessage(packet); }
    catch { closeClient(client); }
  }
  function release(client: Client, id: string) {
    client.held.delete(id);
    const entry = entries.get(id);
    entry?.holders.delete(client.id);
    if (entry && !entry.holders.size) entries.delete(id);
  }
  function unavailable(client: Client, reference: SharedReference, message: string) {
    client.waiting.delete(reference.id);
    send(client, { kind: "unavailable", references: [reference], message });
  }
  function deliverAttachment(client: Client, reference: SharedReference, entry: Entry) {
    if (entry.attachment.byteLength !== reference.byteLength) { unavailable(client, reference, "Shared backing length mismatch"); return; }
    client.waiting.delete(reference.id);
    entry.holders.add(client.id); client.held.add(reference.id);
    send(client, { kind: "attached", attachments: [entry.attachment] });
  }
  function publish(client: Client, packet: Extract<SharedRequest, { kind: "publish" }>) {
    const seen = new Set<string>();
    for (const attachment of packet.attachments) {
      if (!attachment.id.startsWith(`${client.id}/`) || seen.has(attachment.id) || entries.has(attachment.id) || client.retired.has(attachment.id)) throw sharedError("Invalid shared publication");
      seen.add(attachment.id);
    }
    if (client.held.size + packet.attachments.length > sharedObjectLimit) throw sharedError("Shared-object limit exceeded");
    for (const attachment of packet.attachments) {
      entries.set(attachment.id, { attachment, publisher: client.id, transaction: packet.transaction, holders: new Set([client.id]), mailbox: false, revoked: false });
      client.held.add(attachment.id);
    }
    for (const peer of Array.from(clients.values())) deliverWaiting(peer);
  }
  function deliverWaiting(client: Client) {
    for (const reference of Array.from(client.waiting.values())) {
      const entry = entries.get(reference.id);
      if (entry) deliverAttachment(client, reference, entry);
    }
  }
  function need(client: Client, reference: SharedReference) {
    const entry = entries.get(reference.id);
    if (entry?.revoked) { unavailable(client, reference, "Shared publication was released"); return; }
    if (entry) { deliverAttachment(client, reference, entry); return; }
    const owner = reference.id.slice(0, reference.id.indexOf("/"));
    if (clients.get(owner)?.retired.has(reference.id)) { unavailable(client, reference, "Shared publication was released"); return; }
    if (!clients.has(owner)) { unavailable(client, reference, "Shared publisher is unavailable"); return; }
    if (client.waiting.size >= sharedObjectLimit) throw sharedError("Shared-object pending limit exceeded");
    client.waiting.set(reference.id, reference);
  }
  function abort(client: Client, transaction: string) {
    const ids: string[] = [];
    for (const [id, entry] of entries) if (entry.publisher === client.id && entry.transaction === transaction) ids.push(id);
    if (client.retired.size + ids.length > sharedObjectLimit) throw sharedError("Shared-object retired limit exceeded");
    for (const id of ids) {
      const entry = entries.get(id);
      if (entry) entry.revoked = true;
      client.retired.add(id);
      release(client, id);
      for (const peer of Array.from(clients.values())) rejectWaiting(peer, id);
    }
  }
  function rejectWaiting(client: Client, id: string) {
    const reference = client.waiting.get(id);
    if (reference) unavailable(client, reference, "Shared publication was released");
  }
  function retainPending(origin: string, target: string, command: SharedRouteCommand) {
    if (pendingSize() >= pendingRouteLimit) throw sharedError("Shared route queue limit exceeded");
    pendingRoutes.push({ origin, target, command });
  }
  function purgePending(target: string, origin?: string) {
    for (let index = pendingRoutes.length - 1; index >= 0; index--) {
      const item = pendingRoutes[index];
      if (!item) continue;
      if (item.target === target || origin !== undefined && item.origin === origin) pendingRoutes.splice(index, 1);
    }
  }
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
  function deliverable(target: string) {
    const owner = routeOwners.get(target)?.owner;
    return owner ? clients.get(owner)?.mailbox : undefined;
  }
  function holderCount(holder: string) {
    let count = 0;
    for (const delivery of deliveries.values()) if (delivery.holder === holder) count++;
    return count;
  }
  function admit(origin: string, command: RoutePacket, replacing?: string) {
    const holder = routeOwners.get(command.id)?.owner;
    const mailbox = holder ? clients.get(holder)?.mailbox : undefined;
    if (!holder || !mailbox || deliveries.size >= deliveryLimit && !replacing || holderCount(holder) >= mailbox.capacity) return false;
    const snapshots = command.kind === "port-data" ? deliveryPorts(command.graph) : [];
    const receipt = crypto.randomUUID();
    const bytes = encoder.encode(JSON.stringify({ ...command, receipt }));
    const reservation = mailbox.reserve(bytes);
    if (!reservation) return false;
    if (replacing) deliveries.delete(replacing);
    deliveries.set(receipt, { holder, origin, command, returned: false });
    for (const snapshot of snapshots) claimDeliveryPort(snapshot, origin, holder);
    reservation.commit();
    return true;
  }
  function deliveryPorts(graph: unknown) {
    if (!graph || typeof graph !== "object" || !("nodes" in graph) || !Array.isArray(graph.nodes)) throw sharedError("Invalid delivered graph");
    const ports: { id: string; version: number }[] = [];
    for (const node of graph.nodes) {
      if (!Array.isArray(node) || node[0] !== "port") continue;
      ports.push(deliveryPort(node[1]));
    }
    return ports;
  }
  function deliveryPort(value: unknown) {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
      || !("version" in value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version)) throw sharedError("Invalid delivered port");
    return { id: value.id, version: value.version };
  }
  function claimDeliveryPort(value: { id: string; version: number }, origin: string, holder: string) {
    const endpoint = routeOwners.get(value.id);
    if (endpoint && !endpoint.owner && endpoint.version === value.version && (endpoint.origin === origin || endpoint.expected === origin)) endpoint.expected = holder;
  }
  function settleReceipt(origin: string, command: Extract<SharedRouteCommand, { kind: "received" | "returned" }>) {
    const delivery = deliveries.get(command.receipt);
    if (!delivery) return;
    if (delivery.holder !== origin) throw sharedError("Mailbox receipt belongs to another owner");
    if (command.kind === "received") deliveries.delete(command.receipt);
    else delivery.returned = true;
  }
  function rerouteDeliveries() {
    for (const [receipt, delivery] of deliveries) {
      const endpoint = routeOwners.get(delivery.command.id);
      if (!endpoint) { deliveries.delete(receipt); continue; }
      if (!delivery.returned && endpoint.owner === delivery.holder) continue;
      if (endpoint.owner === delivery.holder || !endpoint.owner) continue;
      admit(delivery.origin, delivery.command, receipt);
    }
  }
  function flush(target: string) {
    const mailbox = deliverable(target);
    if (!mailbox) return;
    for (let index = 0; index < pendingRoutes.length;) {
      const item = pendingRoutes[index];
      if (!item || item.target !== target) { index++; continue; }
      if (item.command.kind !== "port-data" && item.command.kind !== "port-close") throw sharedError("Invalid pending delivery");
      if (!admit(item.origin, item.command)) return;
      pendingRoutes.splice(index, 1);
    }
    const endpoint = routeOwners.get(target);
    if (endpoint?.terminal && admit("", endpoint.terminal)) delete endpoint.terminal;
  }
  function retire(id: string, endpoint: Endpoint) {
    routeOwners.delete(id); purgePending(id);
    registrations.delete(id);
    if (!endpoint.peer) return;
    const peer = routeOwners.get(endpoint.peer);
    const owner = peer?.owner ? clients.get(peer.owner) : undefined;
    if (owner) send(owner, { kind: "route-retired", id });
    if (!peer) return;
    peer.terminal = { kind: "port-close", id: endpoint.peer, from: id, sequence: endpoint.sent };
    flush(endpoint.peer);
  }
  function deferRegistration(origin: string, command: Extract<SharedRouteCommand, { kind: "bind" | "moving" }>) {
    if (registrations.size >= sharedObjectLimit) throw sharedError("Shared route registration limit exceeded");
    registrations.set(command.snapshot.id, { origin, command });
  }
  function bindEndpoint(origin: string, command: Extract<SharedRouteCommand, { kind: "bind" | "moving" }>) {
    const snapshot = command.snapshot, previous = routeOwners.get(snapshot.id);
    if (previous && snapshot.version < previous.version) return;
    const publisher = snapshot.id.slice(0, snapshot.id.indexOf(":"));
    if (!previous && !clients.has(publisher)) throw sharedError("Route publisher is unavailable");
    if (command.kind === "bind" && snapshot.version > 0 && (!previous || previous.owner && previous.owner !== origin)) {
      deferRegistration(origin, command); return;
    }
    if (!previous && !snapshot.id.startsWith(`${origin}:`)) throw sharedError("Route endpoint has no owner");
    if (previous?.owner && previous.owner !== origin) throw sharedError("Route endpoint belongs to another owner");
    if (!previous && routeOwners.size >= sharedObjectLimit) throw sharedError("Shared route endpoint limit exceeded");
    routeOwners.set(snapshot.id, { owner: command.kind === "bind" ? origin : null, origin, expected: command.kind === "bind" ? origin : null,
      version: snapshot.version, peer: snapshot.peer, sent: Math.max(snapshot.sent, previous?.sent ?? 0), terminal: previous?.terminal });
    const registration = registrations.get(snapshot.id);
    if (command.kind === "moving" && registration?.command.snapshot.version === snapshot.version) {
      registrations.delete(snapshot.id); deliver(registration.origin, registration.command);
    }
    if (command.kind === "bind") flush(snapshot.id);
  }
  function deliver(origin: string, command: SharedRouteCommand, sources?: ReadonlyMap<string, Source>) {
    if (command.kind === "received" || command.kind === "returned") { settleReceipt(origin, command); return; }
    if (command.kind === "bind" || command.kind === "moving") { bindEndpoint(origin, command); return; }
    if (command.kind === "closed") {
      const endpoint = routeOwners.get(command.id);
      if (!endpoint) { cancelDeferredBinding(origin, command.id); return; }
      if ((endpoint.owner ?? endpoint.expected) !== origin) return;
      retire(command.id, endpoint);
      return;
    }
    if (command.kind !== "port-data" && command.kind !== "port-close") return;
    const source = sources?.get(command.from) ?? routeOwners.get(command.from);
    if (!source || source.owner !== origin || source.peer !== command.id) throw sharedError("Route sender does not own the source port");
    source.sent = Math.max(source.sent, command.sequence + (command.kind === "port-data" ? 1 : 0));
    const current = routeOwners.get(command.from);
    if (current?.owner === source.owner && current.version === source.version) current.sent = Math.max(current.sent, source.sent);
    if (command.kind === "port-close") {
      const endpoint = routeOwners.get(command.id);
      if (endpoint) endpoint.terminal = command;
      flush(command.id); return;
    }
    const mailbox = deliverable(command.id);
    if (!mailbox || pendingRoutes.some(item => item.target === command.id)
      || !admit(origin, command)) retainPending(origin, command.id, command);
  }
  function cancelDeferredBinding(origin: string, id: string) {
    for (const batch of deferredBatches) {
      if (batch.origin !== origin) continue;
      batch.commands = batch.commands.filter(command => !((command.kind === "bind" || command.kind === "moving") && command.snapshot.id === id));
    }
    if (registrations.get(id)?.origin === origin) registrations.delete(id);
  }
  function authorizeSources(origin: string, commands: readonly SharedRouteCommand[]) {
    const sources = new Map<string, Source>();
    for (const command of commands) {
      if (command.kind !== "port-data" && command.kind !== "port-close") continue;
      sources.set(command.from, authorizeSource(origin, command.from, command.id));
    }
    return sources;
  }
  function authorizeSource(origin: string, id: string, peer: string): Source {
    const existing = routeOwners.get(id);
    if (existing?.owner === origin && existing.peer === peer) return { owner: origin, peer, version: existing.version, sent: existing.sent };
    for (const batch of deferredBatches) {
      if (batch.origin !== origin) continue;
      const bind = batch.commands.find(command => command.kind === "bind" && command.snapshot.id === id && command.snapshot.peer === peer);
      if (bind?.kind === "bind") return { owner: origin, peer, version: bind.snapshot.version, sent: bind.snapshot.sent };
    }
    throw sharedError("Deferred source port has no owner");
  }
  function batchReady(commands: readonly SharedRouteCommand[], authorized = false) {
    return registrationCapacity(commands) && (authorized || !commands.some(command => command.kind === "port-data" && !routeOwners.has(command.from)));
  }
  function rememberSources(client: Client, commands: readonly SharedRouteCommand[], cursor: number) {
    if (client.sources.has(cursor)) return;
    const sources = new Map<string, Source>();
    for (const command of commands) {
      if (command.kind !== "port-data" && command.kind !== "port-close") continue;
      const source = routeOwners.get(command.from);
      if (source?.owner === client.id && source.peer === command.id) sources.set(command.from, { owner: client.id, peer: source.peer, version: source.version, sent: source.sent });
    }
    if (sources.size) client.sources.set(cursor, sources);
  }
  function progressFrame(client: Client, bytes: Uint8Array, cursor: number) {
    const commands = sharedRouteBatch(JSON.parse(decoder.decode(bytes)));
    rememberSources(client, commands, cursor);
    if (commands.some(command => command.kind === "port-close" && !client.sources.get(cursor)?.has(command.from))) return false;
    const sources = client.sources.get(cursor);
    const authorized = commands.every(command => command.kind !== "port-data" || sources?.has(command.from));
    if (!batchReady(commands, authorized) || pendingSize() + requiredPending(commands) > pendingRouteLimit) return false;
    for (const command of commands) deliver(client.id, command, client.sources.get(cursor));
    client.sources.delete(cursor); return true;
  }
  function drainOutgoing(client: Client) {
    if (!client.outbox) return 0;
    let drained = 0;
    try {
      drained += client.outbox.sweep((bytes, cursor) => progressFrame(client, bytes, cursor));
      drained += client.outbox.drain((bytes, cursor) => consumeBatch(client, bytes, cursor));
    } catch { closeClient(client); }
    if (drained) send(client, { kind: "route-drained" });
    return drained;
  }
  function consumeBatch(client: Client, bytes: Uint8Array, cursor: number) {
    const accepted = acceptBatch(client.id, sharedRouteBatch(JSON.parse(decoder.decode(bytes))), client.sources.get(cursor));
    if (accepted !== false) client.sources.delete(cursor);
    return accepted;
  }
  function acceptBatch(origin: string, commands: SharedRouteCommand[], sources?: Map<string, Source>) {
    if (!batchReady(commands)) {
      if (pendingSize() >= pendingRouteLimit) return false;
      deferredBatches.push({ origin, commands, sources: sources ?? authorizeSources(origin, commands) }); return;
    }
    if (pendingSize() + requiredPending(commands) > pendingRouteLimit) return false;
    for (const command of commands) deliver(origin, command, sources);
  }
  function flushDeferred() {
    let count = 0;
    for (let index = 0; index < deferredBatches.length;) {
      const batch = deferredBatches[index];
      if (!batch || !batchReady(batch.commands, true) || pendingSize() - 1 + requiredPending(batch.commands) > pendingRouteLimit) { index++; continue; }
      deferredBatches.splice(index, 1);
      for (const command of batch.commands) deliver(batch.origin, command, batch.sources);
      count++;
    }
    return count;
  }
  function requiredPending(commands: readonly SharedRouteCommand[]) {
    const available = new Map<ReturnType<typeof createSharedMailbox>, number>();
    let required = 0;
    for (const command of commands) {
      if (command.kind !== "port-data") continue;
      const mailbox = deliverable(command.id);
      if (!mailbox || pendingRoutes.some(item => item.target === command.id)) { required++; continue; }
      const slots = available.get(mailbox) ?? freeSlots(mailbox);
      if (!slots) required++;
      available.set(mailbox, Math.max(0, slots - 1));
    }
    return required;
  }
  function freeSlots(mailbox: ReturnType<typeof createSharedMailbox>) {
    let terminals = 0;
    for (const [id, endpoint] of routeOwners) if (endpoint.terminal && deliverable(id) === mailbox) terminals++;
    const client = Array.from(clients.values()).find(client => client.mailbox === mailbox);
    const held = client ? holderCount(client.id) : mailbox.capacity;
    return Math.max(0, Math.min(mailbox.capacity - mailbox.inspect().queued, mailbox.capacity - held, deliveryLimit - deliveries.size) - terminals);
  }
  function registrationCapacity(commands: readonly SharedRouteCommand[]) {
    const fresh = new Set<string>();
    for (const command of commands) {
      if ((command.kind === "bind" || command.kind === "moving") && !routeOwners.has(command.snapshot.id)) fresh.add(command.snapshot.id);
    }
    return routeOwners.size + fresh.size <= sharedObjectLimit && registrations.size + fresh.size <= sharedObjectLimit;
  }
  function credit() {
    if (draining) return;
    draining = true;
    try { while (drainClients()) { /* Each pass consumes at least one previously committed frame. */ } }
    finally { draining = false; }
  }
  function drainClients() {
    rerouteDeliveries();
    let drained = flushDeferred();
    for (const id of routeOwners.keys()) flush(id);
    for (const client of Array.from(clients.values())) drained += drainOutgoing(client);
    return drained > 0;
  }
  function receive(client: Client, value: unknown) {
    const packet = sharedRequest(value);
    switch (packet.kind) {
      case "publish": publish(client, packet); return;
      case "abort": abort(client, packet.transaction); return;
      case "need": for (const reference of packet.references) need(client, reference); return;
      case "mailbox": {
        const inbound = entries.get(packet.inbound.id), outbound = entries.get(packet.outbound.id);
        if (!inbound || !outbound || inbound.publisher !== client.id || outbound.publisher !== client.id
          || inbound.attachment.byteLength !== packet.inbound.byteLength || outbound.attachment.byteLength !== packet.outbound.byteLength) throw sharedError("Invalid shared mailbox");
        inbound.mailbox = true; outbound.mailbox = true;
        client.mailbox = createSharedMailbox(inbound.attachment.buffer);
        client.outbox = createSharedMailbox(outbound.attachment.buffer);
        client.watches.push(client.outbox.watch(credit), client.mailbox.watch(credit));
        credit();
        return;
      }
      case "route-ready": credit(); return;
      case "cancel": for (const reference of packet.references) client.waiting.delete(reference.id); return;
      case "close": closeClient(client); return;
    }
  }
  function closeClient(client: Client) {
    if (!clients.delete(client.id)) return;
    try { client.port?.postMessage({ kind: "closed", message: "Shared-object route is closed" }); } catch { /* Stop retaining a failed route. */ }
    client.sources.clear(); client.detach(); for (const stop of client.watches.splice(0)) stop(); client.port?.close(); client.port = null;
    client.mailbox?.close(); client.mailbox = null;
    client.outbox?.close(); client.outbox = null;
    for (const [id, endpoint] of routeOwners) if ((endpoint.owner ?? endpoint.expected ?? endpoint.origin) === client.id) retire(id, endpoint);
    purgePending(client.id, client.id);
    for (let index = deferredBatches.length - 1; index >= 0; index--) if (deferredBatches[index]?.origin === client.id) deferredBatches.splice(index, 1);
    for (const [receipt, delivery] of deliveries) if (delivery.origin === client.id || delivery.holder === client.id && !routeOwners.has(delivery.command.id)) deliveries.delete(receipt);
    for (const [id, registration] of registrations) if (registration.origin === client.id || id.startsWith(`${client.id}:`)) registrations.delete(id);
    for (const id of Array.from(client.held)) release(client, id);
    client.waiting.clear();
    credit();
    for (const peer of Array.from(clients.values())) rejectPublisher(peer, client.id);
  }
  function rejectPublisher(client: Client, owner: string) {
    for (const reference of Array.from(client.waiting.values())) {
      if (reference.id.startsWith(`${owner}/`)) unavailable(client, reference, "Shared publisher is unavailable");
    }
  }
  function register() {
    if (disposed) throw sharedError("Shared-object broker is disposed");
    if (clients.size >= sharedObjectLimit) throw sharedError("Shared client limit exceeded");
    const id = crypto.randomUUID();
    const client: Client = { id, port: null, mailbox: null, outbox: null, held: new Set(), retired: new Set(), waiting: new Map(), watches: [], sources: new Map(), detach() {} };
    clients.set(id, client);
    function attach(port: SharedPort) {
      if (!clients.has(id) || client.port) { port.close(); throw sharedError("Shared-object route is unavailable"); }
      client.port = port;
      const onMessage = (event: Event) => {
        if (!clients.has(id)) return;
        try { receive(client, messageData(event)); }
        catch { closeClient(client); }
      };
      const onError = () => closeClient(client);
      client.detach = () => { port.removeEventListener("message", onMessage); port.removeEventListener("messageerror", onError); };
      port.addEventListener("message", onMessage); port.addEventListener("messageerror", onError); port.start();
    }
    return { id, attach, close: () => closeClient(client) };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const client of Array.from(clients.values())) closeClient(client);
  }
  return { register, dispose, inspectDeliveries: () => ({ receipts: deliveries.size, deferred: deferredBatches.length }), inspectRoutes: () => ({ endpoints: routeOwners.size, pending: pendingRoutes.length, registrations: registrations.size }), inspect: () => ({ clients: clients.size, objects: Array.from(entries.values()).filter(entry => !entry.mailbox).length, waiting: Array.from(clients.values()).reduce((count, client) => count + client.waiting.size, 0) }) };
}
