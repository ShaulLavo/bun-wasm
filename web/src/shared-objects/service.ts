import { createSharedMailbox } from "./mailbox.ts";
import { messageData, sharedBufferLength, sharedError, sharedObjectLimit, sharedResponse, sharedRouteCommand } from "./protocol.ts";
import type { BunSharedNativeHost, SharedAttachment, SharedObjects, SharedPort, SharedPublication, SharedReference } from "./protocol.ts";

export interface SharedObjectService extends SharedObjects {
  close(reason?: DOMException): void;
  inspect(): { buffers: number; pending: number; staged: number; closed: boolean };
}
interface Waiter { readonly ids: Set<string>; readonly ready: () => void; }
export function createSharedObjects(owner: string, port: SharedPort): SharedObjectService {
  if (!/^[\w-]{1,128}$/.test(owner)) throw sharedError("Invalid shared-object owner");
  const buffers = new Map<string, SharedAttachment>();
  const identities = new WeakMap<SharedArrayBuffer, SharedReference>();
  const pending = new Map<string, { reference: SharedReference; waiters: Set<Waiter> }>();
  const failures = new Map<string, DOMException>();
  const publications = new Set<SharedPublication>();
  const reservedIdentities = new WeakSet<SharedArrayBuffer>();
  let reserved = 0;
  let closed: DOMException | null = null;
  let nextId = 0;
  const mailbox = createSharedMailbox();
  let mailboxPublication: SharedPublication | undefined;
  let routesReady = false;
  let routesEnabled = false;
  function ensureRoutes() {
    if (routesReady) return;
    mailboxPublication = begin();
    const reference = mailboxPublication.reference(mailbox.buffer);
    mailboxPublication.publish();
    port.postMessage({ kind: "mailbox", reference });
    routesReady = true;
  }
  function sendRoute(command: unknown) {
    if (closed || !routesEnabled) return false;
    active();
    ensureRoutes();
    port.postMessage({ kind: "route", command: sharedRouteCommand(command) });
    return true;
  }
  function active() { if (closed) throw closed; }
  function present(reference: SharedReference) {
    active();
    const failure = failures.get(reference.id);
    if (failure) throw failure;
    const attachment = buffers.get(reference.id);
    if (attachment && attachment.byteLength !== reference.byteLength) throw sharedError("Shared backing length mismatch");
    return attachment;
  }
  function read(reference: SharedReference) {
    const attachment = present(reference);
    if (!attachment) throw sharedError("Shared backing is not attached");
    return attachment.buffer;
  }
  function settled(id: string) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    for (const waiter of request.waiters) {
      waiter.ids.delete(id);
      if (!waiter.ids.size) waiter.ready();
    }
  }
  function receive(value: unknown) {
    const response = sharedResponse(value);
    if (response.kind === "closed") { close(sharedError(response.message)); return; }
    if (response.kind === "unavailable") {
      for (const reference of response.references) {
        if (!pending.has(reference.id)) continue;
        failures.set(reference.id, sharedError(response.message));
        settled(reference.id);
      }
      return;
    }
    for (const attachment of response.attachments) {
      const request = pending.get(attachment.id);
      if (!request) continue;
      if (request.reference.byteLength !== attachment.byteLength) throw sharedError("Shared backing length mismatch");
      if (buffers.size + failures.size >= sharedObjectLimit) throw sharedError("Shared-object limit exceeded");
      buffers.set(attachment.id, attachment);
      identities.set(attachment.buffer, attachment);
      settled(attachment.id);
    }
  }
  function onMessage(event: Event) {
    if (closed) return;
    try { receive(messageData(event)); }
    catch { close(sharedError("Invalid shared-object response")); }
  }
  function close(reason = sharedError("Shared-object service is closed")) {
    if (closed) return;
    closed = reason;
    for (const publication of Array.from(publications)) publication.abort();
    mailboxPublication?.abort();
    const waiters = new Set(Array.from(pending.values()).flatMap(request => Array.from(request.waiters)));
    pending.clear(); buffers.clear(); failures.clear();
    port.removeEventListener("message", onMessage);
    port.removeEventListener("messageerror", onError);
    try { port.postMessage({ kind: "close" }); } catch { /* The peer may already be gone. */ }
    port.close(); mailbox.close();
    for (const waiter of waiters) waiter.ready();
  }
  function onError() { close(sharedError("Shared-object transport failed")); }
  function begin(): SharedPublication {
    active();
    if (publications.size >= sharedObjectLimit) throw sharedError("Shared publication limit exceeded");
    const staged = new Map<SharedArrayBuffer, SharedAttachment>();
    const transaction = crypto.randomUUID();
    let phase: "prepared" | "published" | "aborted" = "prepared";
    function reference(buffer: SharedArrayBuffer): SharedReference {
      active();
      if (phase !== "prepared") throw sharedError("Shared publication is not prepared");
      const known = identities.get(buffer) ?? staged.get(buffer);
      if (known) return known;
      if (reservedIdentities.has(buffer)) throw sharedError("Shared backing already has a pending publication");
      if (buffers.size + failures.size + reserved >= sharedObjectLimit) throw sharedError("Shared-object limit exceeded");
      const attachment = { id: `${owner}/${nextId++}`, byteLength: sharedBufferLength(buffer), buffer };
      staged.set(buffer, attachment); reservedIdentities.add(buffer); reserved++;
      return attachment;
    }
    function publish() {
      active();
      if (phase !== "prepared") throw sharedError("Shared publication is not prepared");
      const attachments = Array.from(staged.values());
      if (attachments.length) port.postMessage({ kind: "publish", transaction, attachments });
      phase = "published";
      unreserve();
      for (const attachment of attachments) { buffers.set(attachment.id, attachment); identities.set(attachment.buffer, attachment); }
      publications.delete(publication);
    }
    function unreserve() {
      reserved -= staged.size;
      for (const buffer of staged.keys()) reservedIdentities.delete(buffer);
    }
    function abort() {
      if (phase === "aborted") return;
      const published = phase === "published";
      if (!published) unreserve();
      phase = "aborted";
      if (published) {
        for (const attachment of staged.values()) { buffers.delete(attachment.id); identities.delete(attachment.buffer); }
        try { if (staged.size) port.postMessage({ kind: "abort", transaction }); } catch { close(sharedError("Shared publication rollback failed")); }
      }
      staged.clear(); publications.delete(publication);
    }
    const publication = { reference, publish, abort };
    publications.add(publication);
    return publication;
  }
  function cancel(waiter: Waiter) {
    const references: SharedReference[] = [];
    for (const id of waiter.ids) {
      const request = pending.get(id);
      request?.waiters.delete(waiter);
      if (!request || request.waiters.size) continue;
      pending.delete(id); references.push(request.reference);
    }
    waiter.ids.clear();
    if (!references.length || closed) return;
    try { port.postMessage({ kind: "cancel", references }); }
    catch { close(sharedError("Shared cancellation failed")); }
  }
  function requestMissing(reference: SharedReference, waiter: Waiter, requested: SharedReference[]) {
    let request = pending.get(reference.id);
    if (!request) {
      if (buffers.size + failures.size + pending.size + reserved >= sharedObjectLimit) throw sharedError("Shared-object pending limit exceeded");
      request = { reference, waiters: new Set() }; pending.set(reference.id, request); requested.push(reference);
    }
    if (request.reference.byteLength !== reference.byteLength) throw sharedError("Shared backing length mismatch");
    request.waiters.add(waiter);
  }
  function wait(references: readonly SharedReference[], ready: () => void) {
    const missing = references.filter(reference => !present(reference));
    if (!missing.length) return null;
    const waiter: Waiter = { ids: new Set(missing.map(reference => reference.id)), ready };
    const requested: SharedReference[] = [];
    try {
      for (const reference of missing) requestMissing(reference, waiter, requested);
      if (requested.length) port.postMessage({ kind: "need", references: requested });
    } catch (error) { cancel(waiter); throw error; }
    return () => cancel(waiter);
  }
  port.addEventListener("message", onMessage);
  port.addEventListener("messageerror", onError);
  port.start();
  return { mailbox, routes: { owner, get enabled() { return routesEnabled; }, enable() { routesEnabled = true; }, send: sendRoute }, begin, read, wait, close, inspect: () => ({ buffers: buffers.size, pending: pending.size, staged: publications.size, closed: closed !== null }) };
}

export function exportSharedObjects(owner: string, host: BunSharedNativeHost) {
  const channel = new MessageChannel();
  const service = createSharedObjects(owner, channel.port1);
  try { host.postMessage({ type: "bun-shared-connect", owner, port: channel.port2 }, [channel.port2]); }
  catch (error) { service.close(); channel.port2.close(); throw error; }
  return service;
}
