import { messageData, sharedError, sharedObjectLimit, sharedRequest } from "./protocol.ts";
import { createSharedMailbox } from "./mailbox.ts";
import type { SharedAttachment, SharedPort, SharedReference, SharedRequest, SharedResponse } from "./protocol.ts";

interface Client { readonly id: string; port: SharedPort | null; mailbox: ReturnType<typeof createSharedMailbox> | null; readonly held: Set<string>; readonly retired: Set<string>; readonly waiting: Map<string, SharedReference>; detach: () => void; }
interface Entry { readonly attachment: SharedAttachment; readonly publisher: string; readonly transaction: string; readonly holders: Set<string>; mailbox: boolean; revoked: boolean; }
export function createSharedObjectBroker() {
  const clients = new Map<string, Client>();
  const entries = new Map<string, Entry>();
  let disposed = false;
  const routeOwners = new Map<string, string>();
  const pendingRoutes = new Map<string, unknown[]>();
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
  function deliver(client: Client, reference: SharedReference, entry: Entry) {
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
      if (entry) deliver(client, reference, entry);
    }
  }
  function need(client: Client, reference: SharedReference) {
    const entry = entries.get(reference.id);
    if (entry?.revoked) { unavailable(client, reference, "Shared publication was released"); return; }
    if (entry) { deliver(client, reference, entry); return; }
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
  function route(client: Client, command: Extract<SharedRequest, { kind: "route" }>['command']) {
    if (command.kind === "bind" || command.kind === "moving") {
      routeOwners.set(command.snapshot.id, client.id);
      const pending = pendingRoutes.get(command.snapshot.id);
      if (pending) {
        pendingRoutes.delete(command.snapshot.id);
        for (const value of pending) route(client, value as Extract<SharedRequest, { kind: "route" }>['command']);
      }
      return;
    }
    if (command.kind === "closed") { routeOwners.delete(command.id); pendingRoutes.delete(command.id); return; }
    if (command.kind !== "port-data" && command.kind !== "port-close") return;
    const targetId = routeOwners.get(command.id);
    const target = targetId ? clients.get(targetId) : undefined;
    if (!target?.mailbox) {
      const pending = pendingRoutes.get(command.id) || [];
      if (pending.length >= sharedObjectLimit) throw sharedError("Shared route queue limit exceeded");
      pending.push(command); pendingRoutes.set(command.id, pending); return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(command));
    if (!target.mailbox.write(bytes)) throw sharedError("Shared route mailbox is full");
  }
  function receive(client: Client, value: unknown) {
    const packet = sharedRequest(value);
    switch (packet.kind) {
      case "publish": publish(client, packet); return;
      case "abort": abort(client, packet.transaction); return;
      case "need": for (const reference of packet.references) need(client, reference); return;
      case "mailbox": {
        const entry = entries.get(packet.reference.id);
        if (!entry || entry.publisher !== client.id || entry.attachment.byteLength !== packet.reference.byteLength) throw sharedError("Invalid shared mailbox");
        entry.mailbox = true;
        client.mailbox = createSharedMailbox(entry.attachment.buffer);
        return;
      }
      case "route": route(client, packet.command); return;
      case "cancel": for (const reference of packet.references) client.waiting.delete(reference.id); return;
      case "close": closeClient(client); return;
    }
  }
  function closeClient(client: Client) {
    if (!clients.delete(client.id)) return;
    try { client.port?.postMessage({ kind: "closed", message: "Shared-object route is closed" }); } catch { /* Stop retaining a failed route. */ }
    client.detach(); client.port?.close(); client.port = null;
    client.mailbox?.close(); client.mailbox = null;
    for (const [id, owner] of routeOwners) if (owner === client.id) { routeOwners.delete(id); pendingRoutes.delete(id); }
    for (const id of Array.from(client.held)) release(client, id);
    client.waiting.clear();
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
    const client: Client = { id, port: null, mailbox: null, held: new Set(), retired: new Set(), waiting: new Map(), detach() {} };
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
  return { register, dispose, inspect: () => ({ clients: clients.size, objects: Array.from(entries.values()).filter(entry => !entry.mailbox).length, waiting: Array.from(clients.values()).reduce((count, client) => count + client.waiting.size, 0) }) };
}
