export interface SharedReference { readonly id: string; readonly byteLength: number; }
export interface SharedAttachment extends SharedReference { readonly buffer: SharedArrayBuffer; }
export type SharedRequest =
  | { readonly kind: "publish"; readonly transaction: string; readonly attachments: readonly SharedAttachment[] }
  | { readonly kind: "abort"; readonly transaction: string }
  | { readonly kind: "need" | "cancel"; readonly references: readonly SharedReference[] }
  | { readonly kind: "close" };
export type SharedResponse =
  | { readonly kind: "closed"; readonly message: string }
  | { readonly kind: "attached"; readonly attachments: readonly SharedAttachment[] }
  | { readonly kind: "unavailable"; readonly references: readonly SharedReference[]; readonly message: string };
export interface SharedPort {
  postMessage(message: SharedRequest | SharedResponse): void;
  addEventListener(type: "message" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "messageerror", listener: EventListener): void;
  start(): void;
  close(): void;
}
export interface BunSharedConnection { readonly type: "bun-shared-connect"; readonly owner: string; readonly port: MessagePort; }
// This is the native worker global, not Waffle's RuntimeWorkerHost message union.
export interface BunSharedNativeHost { postMessage(message: BunSharedConnection, transfer: MessagePort[]): void; }
export interface SharedPublication {
  reference(buffer: SharedArrayBuffer): SharedReference;
  publish(): void;
  abort(): void;
}
export interface SharedObjects {
  begin(): SharedPublication;
  read(reference: SharedReference): SharedArrayBuffer;
  wait(references: readonly SharedReference[], ready: () => void): (() => void) | null;
}
export const sharedObjectLimit = 1024;
const byteLength = typeof SharedArrayBuffer === "function" ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get! : null;
export function sharedBufferLength(value: unknown): number {
  try { if (!byteLength) throw sharedError("Shared backing is unavailable"); return byteLength.call(value); }
  catch { throw new DOMException("Invalid shared backing store", "DataCloneError"); }
}
export function sharedError(message: string): DOMException { return new DOMException(message, "DataCloneError"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw sharedError("Invalid shared-object packet");
  return value as Record<string, unknown>;
}
function sharedReference(value: unknown): SharedReference {
  const input = object(value);
  if (typeof input.id !== "string" || !/^[\w-]{1,128}\/[\w-]{1,128}$/.test(input.id)
    || typeof input.byteLength !== "number" || !Number.isSafeInteger(input.byteLength) || input.byteLength < 0) throw sharedError("Invalid shared-object reference");
  return { id: input.id, byteLength: input.byteLength };
}
function references(value: unknown): SharedReference[] {
  if (!Array.isArray(value) || value.length > sharedObjectLimit) throw sharedError("Invalid shared-object reference list");
  return value.map(sharedReference);
}
function attachments(value: unknown): SharedAttachment[] {
  if (!Array.isArray(value) || value.length > sharedObjectLimit) throw sharedError("Invalid shared-object attachment list");
  return value.map(value => {
    const reference = sharedReference(value);
    const input = object(value);
    if (sharedBufferLength(input.buffer) !== reference.byteLength) throw sharedError("Shared backing length mismatch");
    return { ...reference, buffer: input.buffer as SharedArrayBuffer };
  });
}
function transaction(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) throw sharedError("Invalid shared-object transaction");
  return value;
}
export function sharedRequest(value: unknown): SharedRequest {
  const input = object(value);
  switch (input.kind) {
    case "publish": return { kind: input.kind, transaction: transaction(input.transaction), attachments: attachments(input.attachments) };
    case "abort": return { kind: input.kind, transaction: transaction(input.transaction) };
    case "need": case "cancel": return { kind: input.kind, references: references(input.references) };
    case "close": return { kind: input.kind };
    default: throw sharedError("Invalid shared-object request");
  }
}
export function sharedResponse(value: unknown): SharedResponse {
  const input = object(value);
  if (input.kind === "closed" && typeof input.message === "string") return { kind: input.kind, message: input.message };
  if (input.kind === "attached") return { kind: input.kind, attachments: attachments(input.attachments) };
  if (input.kind === "unavailable" && typeof input.message === "string") return { kind: input.kind, references: references(input.references), message: input.message };
  throw sharedError("Invalid shared-object response");
}
export function messageData(event: Event): unknown {
  if (!("data" in event)) throw sharedError("Missing shared-object packet");
  return event.data;
}
