export interface SharedReference { readonly id: string; readonly byteLength: number; }
export type SharedWasmValue = WebAssembly.Module | WebAssembly.Memory;
export type SharedAttachment = SharedReference & (
  | { readonly buffer: SharedArrayBuffer }
  | { readonly module: WebAssembly.Module }
  | { readonly memory: WebAssembly.Memory }
);
export function sharedAttachmentValue(attachment: SharedAttachment) {
  if ("buffer" in attachment) return attachment.buffer;
  if ("module" in attachment) return attachment.module;
  return attachment.memory;
}
export type SharedRequest =
  | { readonly kind: "publish"; readonly transaction: string; readonly attachments: readonly SharedAttachment[] }
  | { readonly kind: "abort"; readonly transaction: string }
  | { readonly kind: "need" | "cancel" | "accept"; readonly request: string; readonly references: readonly SharedReference[] }
  | { readonly kind: "mailbox"; readonly inbound: SharedReference; readonly outbound: SharedReference }
  | { readonly kind: "route-ready" }
  | { readonly kind: "close" };
export type SharedResponse =
  | { readonly kind: "route-drained" }
  | { readonly kind: "route-retired"; readonly id: string }
  | { readonly kind: "closed"; readonly message: string }
  | { readonly kind: "attached"; readonly request: string; readonly attachments: readonly SharedAttachment[] }
  | { readonly kind: "unavailable"; readonly request: string; readonly references: readonly SharedReference[]; readonly message: string };
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
  referenceWasm?(value: WebAssembly.Module | WebAssembly.Memory): SharedReference;
  publish(): void;
  abort(): void;
}
interface SharedRouteSnapshot { readonly id: string; readonly peer: string | null; readonly version: number; readonly sent: number; }
export type SharedRouteCommand =
  // `toward`: the port a moving endpoint was sent to over its channel lane, which holds it until restored.
  | { readonly kind: "bind" | "moving"; readonly snapshot: SharedRouteSnapshot; readonly toward?: string }
  | { readonly kind: "received" | "returned"; readonly receipt: string }
  | { readonly kind: "closed"; readonly id: string }
  | { readonly kind: "port-data"; readonly id: string; readonly from: string; readonly sequence: number; readonly graph: unknown }
  | { readonly kind: "port-close"; readonly id: string; readonly from: string; readonly sequence: number };
interface SharedRoutes {
  readonly owner: string;
  readonly enabled: boolean;
  enable(): void;
  send(command: unknown): boolean;
  /** Whether the broker has reported this endpoint retired: nothing more can reach it. */
  retired(id: string): boolean;
  tryTransaction(deliver: () => void, commit: () => void): boolean;
  onCredit(ready: () => void): void;
  transaction(deliver: () => void, commit: () => void): void;
  credit(): void;
}
interface SharedLanes {
  create(): SharedArrayBuffer;
  open(buffer: SharedArrayBuffer, side: 0 | 1): import("./lane.ts").SharedLane;
}
export interface SharedObjects {
  readonly mailbox?: import("./mailbox.ts").SharedMailbox;
  readonly lanes?: SharedLanes;
  readonly routes?: SharedRoutes;
  begin(): SharedPublication;
  read(reference: SharedReference): SharedArrayBuffer;
  readWasm?(reference: SharedReference): WebAssembly.Module | WebAssembly.Memory;
  wait(references: readonly SharedReference[], ready: () => void): (() => void) | null;
}
export const sharedObjectLimit = 1024;
const byteLength = typeof SharedArrayBuffer === "function" ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get! : null;
export function sharedBufferLength(value: unknown): number {
  try { if (!byteLength) throw sharedError("Shared backing is unavailable"); return byteLength.call(value); }
  catch { throw new DOMException("Invalid shared backing store", "DataCloneError"); }
}
function isSharedBuffer(value: unknown): value is SharedArrayBuffer {
  try { sharedBufferLength(value); return true; }
  catch { return false; }
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
    if ("module" in input && input.module instanceof WebAssembly.Module && reference.byteLength === 0) return { ...reference, module: input.module };
    if ("memory" in input && input.memory instanceof WebAssembly.Memory && reference.byteLength === 0) {
      sharedBufferLength(input.memory.buffer);
      return { ...reference, memory: input.memory };
    }
    if (!isSharedBuffer(input.buffer) || sharedBufferLength(input.buffer) !== reference.byteLength) throw sharedError("Shared backing length mismatch");
    return { ...reference, buffer: input.buffer };
  });
}
function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw sharedError("Invalid shared route counter");
  return value;
}
function routeId(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) throw sharedError("Invalid shared route ID");
  return value;
}
function routeSnapshot(value: unknown): SharedRouteSnapshot {
  const input = object(value);
  return { id: routeId(input.id), peer: input.peer === null ? null : routeId(input.peer), version: counter(input.version), sent: counter(input.sent) };
}
function routeCommand(value: unknown): SharedRouteCommand {
  const input = object(value);
  if (input.kind === "bind") return { kind: input.kind, snapshot: routeSnapshot(input.snapshot) };
  if (input.kind === "moving") {
    const snapshot = routeSnapshot(input.snapshot);
    return input.toward === undefined ? { kind: input.kind, snapshot } : { kind: input.kind, snapshot, toward: routeId(input.toward) };
  }
  if (input.kind === "received" || input.kind === "returned") return { kind: input.kind, receipt: transaction(input.receipt) };
  if (input.kind === "closed") return { kind: input.kind, id: routeId(input.id) };
  if ((input.kind === "port-data" || input.kind === "port-close") && typeof input.id === "string" && typeof input.from === "string") {
    const command = { id: routeId(input.id), from: routeId(input.from), sequence: counter(input.sequence) };
    if (input.kind === "port-data") return { kind: "port-data", ...command, graph: input.graph };
    return { kind: "port-close", ...command };
  }
  throw sharedError("Invalid shared route command");
}
function transaction(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) throw sharedError("Invalid shared-object transaction");
  return value;
}
export function sharedRouteCommand(value: unknown): SharedRouteCommand { return routeCommand(value); }
export function sharedRouteBatch(value: unknown): SharedRouteCommand[] {
  if (!Array.isArray(value) || !value.length || value.length > sharedObjectLimit) throw sharedError("Invalid shared route batch");
  return value.map(routeCommand);
}
export function sharedRequest(value: unknown): SharedRequest {
  const input = object(value);
  switch (input.kind) {
    case "publish": return { kind: input.kind, transaction: transaction(input.transaction), attachments: attachments(input.attachments) };
    case "abort": return { kind: input.kind, transaction: transaction(input.transaction) };
    case "mailbox": return { kind: input.kind, inbound: sharedReference(input.inbound), outbound: sharedReference(input.outbound) };
    case "route-ready": return { kind: input.kind };
    case "need": case "cancel": case "accept": return { kind: input.kind, request: transaction(input.request), references: references(input.references) };
    case "close": return { kind: input.kind };
    default: throw sharedError("Invalid shared-object request");
  }
}
export function sharedResponse(value: unknown): SharedResponse {
  const input = object(value);
  if (input.kind === "route-drained") return { kind: input.kind };
  if (input.kind === "route-retired" && typeof input.id === "string") return { kind: input.kind, id: input.id };
  if (input.kind === "closed" && typeof input.message === "string") return { kind: input.kind, message: input.message };
  if (input.kind === "attached") return { kind: input.kind, request: transaction(input.request), attachments: attachments(input.attachments) };
  if (input.kind === "unavailable" && typeof input.message === "string") return { kind: input.kind, request: transaction(input.request), references: references(input.references), message: input.message };
  throw sharedError("Invalid shared-object response");
}
export function messageData(event: Event): unknown {
  if (!("data" in event)) throw sharedError("Missing shared-object packet");
  return event.data;
}
