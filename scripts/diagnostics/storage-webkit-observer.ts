import { captureProcessObserver, type ProcessObserver } from "waffle/proc/observation";

type Event = { time: number; kind: string; detail: unknown };
type Identity = { owner: number; sections: SharedArrayBuffer; ownerStates: SharedArrayBuffer; revocations: SharedArrayBuffer[] };
type Process = { worker: number; pid: number; args: unknown; observer: ProcessObserver };
const events: Event[] = [];
const identities = new Map<number, Identity>();
const processes: Process[] = [];
let dropped = 0;
let sequence = 0;
let output = "";
function record(kind: string, detail: unknown): void {
  if (events.length >= 30000) { dropped++; return; }
  events.push({ time: performance.timeOrigin + performance.now(), kind, detail });
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function identity(value: unknown): void {
  if (!object(value) || typeof value.owner !== "number" || !(value.sections instanceof SharedArrayBuffer) || !(value.ownerStates instanceof SharedArrayBuffer)) return;
  if (!Array.isArray(value.revocations) || !value.revocations.every(buffer => buffer instanceof SharedArrayBuffer)) return;
  identities.set(value.owner, { owner: value.owner, sections: value.sections, ownerStates: value.ownerStates, revocations: value.revocations });
}
function filesystem() {
  return Array.from(identities.values(), value => ({ owner: value.owner, sections: Atomics.load(new Int32Array(value.sections), 0), probe: Atomics.load(new Int32Array(value.sections), 1), service: Atomics.load(new Int32Array(value.ownerStates), 0), live: Atomics.load(new Int32Array(value.ownerStates), value.owner), revoked: value.revocations.map(buffer => Atomics.load(new Int32Array(buffer), 0)) }));
}
function outcomes() {
  return processes.map(value => {
    try { return { worker: value.worker, pid: value.pid, args: value.args, state: value.observer.read() }; }
    catch (error) { return { worker: value.worker, pid: value.pid, error: String(error) }; }
  });
}
function capture(worker: number, message: unknown): void {
  if (!object(message)) return;
  identity(message.filesystem);
  identity(message.connect);
  const value = message.runtimeProcess;
  if (!object(value) || value.kind !== "directory" || typeof value.pid !== "number" || typeof value.slot !== "number" || !(value.directory instanceof SharedArrayBuffer) || !(value.lifetime instanceof SharedArrayBuffer)) return;
  const observer = captureProcessObserver({ kind: "directory", pid: value.pid, slot: value.slot, directory: value.directory, lifetime: value.lifetime });
  processes.push({ worker, pid: value.pid, args: message.args, observer });
  if (object(value.data)) identity(value.data.filesystem);
  record("process-captured", { worker, pid: value.pid, args: message.args, filesystem: filesystem() });
}
function describe(message: unknown): unknown {
  if (!object(message)) return typeof message;
  const text = message.data instanceof Uint8Array ? new TextDecoder().decode(message.data) : undefined;
  return { keys: Object.keys(message), type: message.type, operation: message.operation, code: message.code, signal: message.signal, text };
}
function receive(worker: number, message: unknown) {
  if (object(message) && message.data instanceof Uint8Array && (message.type === "stdout" || message.type === "stderr")) output = (output + new TextDecoder().decode(message.data)).slice(-1048576);
  record("worker-message", { worker, message: describe(message), filesystem: filesystem() });
}
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  readonly diagnosticId = ++sequence;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    record("worker-created", { worker: this.diagnosticId, url: String(url) });
    this.addEventListener("message", event => receive(this.diagnosticId, event.data));
    this.addEventListener("messageerror", () => record("worker-messageerror", { worker: this.diagnosticId }));
    this.addEventListener("error", event => record("worker-error", { worker: this.diagnosticId, error: event.message }));
  }
  override postMessage(message: unknown, transfer: Transferable[]): void;
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    try { capture(this.diagnosticId, message); }
    catch (error) { record("capture-error", String(error)); }
    record("worker-post", { worker: this.diagnosticId, message: describe(message), filesystem: filesystem() });
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
  override terminate(): void {
    record("terminate-called", { worker: this.diagnosticId, processes: outcomes(), filesystem: filesystem() });
    super.terminate();
    record("terminate-returned", { worker: this.diagnosticId, filesystem: filesystem() });
  }
};
const nativePost = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
  if (object(message) && ("sweep" in message || "transportClosed" in message || "connect" in message)) record("port-control", { message: describe(message), filesystem: filesystem() });
  Reflect.apply(nativePost, this, [message, options]);
};
const api = {
  mark(label: string) { record("marker", { label, processes: outcomes(), filesystem: filesystem() }); },
  snapshot() { return { events, dropped, output, processes: outcomes(), filesystem: filesystem() }; },
};
Object.assign(globalThis, { __storageDiagnostic: api });
document.addEventListener("click", event => {
  if (event.target instanceof Element && event.target.closest("#restart")) api.mark("sandbox replacement click");
}, true);
export type StorageDiagnostic = typeof api;
