import { messageData, sharedError, sharedObjectLimit, sharedRequest, sharedRouteBatch } from "./protocol.ts";
import { createSharedMailbox } from "./mailbox.ts";
import type { SharedAttachment, SharedPort, SharedReference, SharedRequest, SharedResponse, SharedRouteCommand } from "./protocol.ts";

interface Client { readonly id: string; port: SharedPort | null; mailbox: ReturnType<typeof createSharedMailbox> | null; outbox: ReturnType<typeof createSharedMailbox> | null; readonly held: Set<string>; readonly retired: Set<string>; readonly waiting: Map<string, SharedReference>; detach: () => void; }
interface Entry { readonly attachment: SharedAttachment; readonly publisher: string; readonly transaction: string; readonly holders: Set<string>; mailbox: boolean; revoked: boolean; }
export function createSharedObjectBroker() {
  const clients = new Map<string, Client>();
  const entries = new Map<string, Entry>();
  let disposed = false;
  interface Endpoint { owner: string | null; origin: string; version: number; peer: string | null; sent: number; terminal?: Extract<SharedRouteCommand, { kind: "port-close" }>; }
  const routeOwners = new Map<string, Endpoint>();
  const registrations = new Map<string, { origin: string; command: Extract<SharedRouteCommand, { kind: "bind" | "moving" }> }>();
  const pendingRoutes: { origin: string; target: string; command: SharedRouteCommand }[] = [];
  const pendingRouteLimit = sharedObjectLimit;
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
    if (pendingRoutes.length >= pendingRouteLimit) throw sharedError("Shared route queue limit exceeded");
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
  function flush(target: string) {
    const mailbox = deliverable(target);
    if (!mailbox) return;
    for (let index = 0; index < pendingRoutes.length;) {
      const item = pendingRoutes[index];
      if (!item || item.target !== target) { index++; continue; }
      if (!mailbox.write(encoder.encode(JSON.stringify(item.command)))) return;
      pendingRoutes.splice(index, 1);
    }
    const endpoint = routeOwners.get(target);
    if (endpoint?.terminal && mailbox.write(encoder.encode(JSON.stringify(endpoint.terminal)))) delete endpoint.terminal;
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
    routeOwners.set(snapshot.id, { owner: command.kind === "bind" ? origin : null, origin,
      version: snapshot.version, peer: snapshot.peer, sent: Math.max(snapshot.sent, previous?.sent ?? 0), terminal: previous?.terminal });
    const registration = registrations.get(snapshot.id);
    if (command.kind === "moving" && registration?.command.snapshot.version === snapshot.version) {
      registrations.delete(snapshot.id); deliver(registration.origin, registration.command);
    }
    if (command.kind === "bind") flush(snapshot.id);
  }
  function deliver(origin: string, command: SharedRouteCommand) {
    if (command.kind === "bind" || command.kind === "moving") { bindEndpoint(origin, command); return; }
    if (command.kind === "closed") {
      const endpoint = routeOwners.get(command.id);
      if (endpoint?.owner !== origin) return;
      retire(command.id, endpoint);
      return;
    }
    if (command.kind !== "port-data" && command.kind !== "port-close") return;
    const source = routeOwners.get(command.from);
    if (!source || source.owner !== origin || source.peer !== command.id) throw sharedError("Route sender does not own the source port");
    source.sent = Math.max(source.sent, command.sequence + (command.kind === "port-data" ? 1 : 0));
    if (command.kind === "port-close") {
      const endpoint = routeOwners.get(command.id);
      if (endpoint) endpoint.terminal = command;
      flush(command.id); return;
    }
    const mailbox = deliverable(command.id);
    if (!mailbox || pendingRoutes.some(item => item.target === command.id)
      || !mailbox.write(encoder.encode(JSON.stringify(command)))) retainPending(origin, command.id, command);
  }
  function drainOutgoing(client: Client) {
    if (!client.outbox) return 0;
    const drained = client.outbox.drain(bytes => {
      const commands = sharedRouteBatch(JSON.parse(decoder.decode(bytes)));
      if (pendingRoutes.length + requiredPending(commands) > pendingRouteLimit) return false;
      if (!registrationCapacity(commands)) return false;
      for (const command of commands) deliver(client.id, command);
    });
    if (drained) send(client, { kind: "route-drained" });
    return drained;
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
    return Math.max(0, mailbox.capacity - mailbox.inspect().queued - terminals);
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
    for (const id of routeOwners.keys()) flush(id);
    let drained = 0;
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
        return;
      }
      case "route-ready": credit(); return;
      case "route-credit": credit(); return;
      case "cancel": for (const reference of packet.references) client.waiting.delete(reference.id); return;
      case "close": closeClient(client); return;
    }
  }
  function closeClient(client: Client) {
    if (!clients.delete(client.id)) return;
    try { client.port?.postMessage({ kind: "closed", message: "Shared-object route is closed" }); } catch { /* Stop retaining a failed route. */ }
    client.detach(); client.port?.close(); client.port = null;
    client.mailbox?.close(); client.mailbox = null;
    client.outbox?.close(); client.outbox = null;
    for (const [id, endpoint] of routeOwners) if ((endpoint.owner ?? endpoint.origin) === client.id) retire(id, endpoint);
    purgePending(client.id, client.id);
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
    const client: Client = { id, port: null, mailbox: null, outbox: null, held: new Set(), retired: new Set(), waiting: new Map(), detach() {} };
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
  return { register, dispose, inspectRoutes: () => ({ endpoints: routeOwners.size, pending: pendingRoutes.length, registrations: registrations.size }), inspect: () => ({ clients: clients.size, objects: Array.from(entries.values()).filter(entry => !entry.mailbox).length, waiting: Array.from(clients.values()).reduce((count, client) => count + client.waiting.size, 0) }) };
}
