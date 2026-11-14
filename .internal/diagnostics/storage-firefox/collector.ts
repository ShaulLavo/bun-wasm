import type { Runtime } from "../../../sandbox/node_modules/waffle/index.ts";
import { postedIdentity, forwardPost } from "./post.ts";
import { belongs, handshake, type Association } from "./worker-transport.ts";
import type { EntryCommand } from "./controls.ts";

declare const sandbox: { runtime: Runtime; fs: Runtime["filesystem"]; engine: string; profile: string; template: string; status(): unknown; server(): unknown; started(): boolean };
const rows: object[] = [];
const pending = new Set<Promise<unknown>>();
const capture = crypto.randomUUID();
const NativeWorker = globalThis.Worker;
const nativePost = NativeWorker.prototype.postMessage;
const workerURLs: string[] = [];
const peers = new Map<number, { port: MessagePort; own: Association; services: Set<string> }>();
const snapshots = new Map<string, { remaining: Set<number>; done(): void }>();
let selectedRuntime: Runtime | undefined;
let runtimeRegistrations = 0;
let runtimeChanged = false;
let sequence = 0;
let nextWorkerId = 0;
let commandId = "original-startup";

function record(value: object) {
  const row = { capture, origin: location.origin, pageURL: location.href, cell: commandId, collectorSequence: ++sequence, ...value };
  rows.push(row);
  const sink = Reflect.get(globalThis, "storageEndpointRecord");
  if (typeof sink !== "function") throw Error("diagnostic raw binding is not armed before original main");
  const operation = Promise.resolve(sink(row));
  pending.add(operation);
  void operation.catch(() => {}).finally(() => pending.delete(operation));
}
function receive(workerId: number, event: MessageEvent) {
  const peer = peers.get(workerId);
  if (!peer || !belongs(event.data, peer.own)) { record({ kind: "observation-rejected", workerId, data: event.data }); return; }
  const data = event.data.payload;
  record({ kind: "endpoint", ...data, ...peer.own });
  if (data.snapshot?.endpoint === "service") peer.services.add(`${data.snapshot.owner}:${data.snapshot.generation}`);
  if (data.command === "fault-service") relayFault(workerId, data);
  if (data.kind !== "service-snapshot-complete") return;
  const snapshot = snapshots.get(data.token);
  snapshot?.remaining.delete(workerId);
  if (snapshot?.remaining.size === 0) snapshot.done();
}
function relayFault(requestorWorkerId: number, data: Record<string, unknown>) {
  const key = `${data.owner}:${data.generation}`;
  const matching = Array.from(peers.values()).filter(peer => peer.services.has(key));
  if (matching.length !== 1) throw Error("labelled fault lacks one service in this actual page runtime");
  const peer = matching[0]!;
  peer.port.postMessage({ ...peer.own, payload: { ...data, requestorWorkerId } });
}
function attachTransport(worker: Worker, url: string, own: Association) {
  if (!/\/(?:fs-worker|worker|shell-worker)\.js$/.test(new URL(url).pathname)) return;
  const pair = new MessageChannel();
  peers.set(own.workerId, { port: pair.port1, own, services: new Set() });
  pair.port1.onmessage = event => receive(own.workerId, event);
  Reflect.apply(nativePost, worker, [{ diagnostic: handshake, ...own }, [pair.port2]]);
}
globalThis.Worker = class extends NativeWorker {
  readonly workerId = ++nextWorkerId;
  private posted: ReturnType<typeof postedIdentity> = null;
  readonly observerURL: string;
  constructor(...args: ConstructorParameters<typeof NativeWorker>) {
    super(...args);
    this.observerURL = new URL(String(args[0]), location.href).href;
    workerURLs.push(this.observerURL);
    const own = { runtimeId: capture, workerId: this.workerId };
    attachTransport(this, this.observerURL, own);
    record({ kind: "native-worker", ...own, url: this.observerURL, options: args[1] ?? null });
    this.addEventListener("message", ({ data }) => {
      if (!["exit", "error", "cleanup-error", "phase", "filesystem-disposed"].includes(data?.type)) return;
      record({ kind: "native-message", ...own, url: this.observerURL, posted: this.posted,
        type: data.type, code: data.code, message: data.message, errno: data.errno, phase: data.name });
    });
    this.addEventListener("error", event => record({ kind: "native-error", ...own, url: this.observerURL, posted: this.posted, message: event.message }));
  }
  override postMessage(...args: [message: unknown, options?: Transferable[] | StructuredSerializeOptions]) {
    const posted = postedIdentity(args[0]);
    if (!posted) return Reflect.apply(nativePost, this, args);
    this.posted = posted;
    return forwardPost(nativePost, this, args, record, { runtimeId: capture, workerId: this.workerId, url: this.observerURL, posted });
  }
};
function snapshot() {
  const app = typeof sandbox === "undefined" ? undefined : sandbox;
  if (selectedRuntime && app && selectedRuntime !== app.runtime) runtimeChanged = true;
  if (app) selectedRuntime ??= app.runtime;
  return { source: "84ff8588028edcc013eb67aa4bb740b3a518b96d", capture, rows, workerURLs, runtimeChanged, runtimeRegistrations,
    originalRuntimeExposed: !!app, originalFilesystem: !!app && app.fs === app.runtime.filesystem,
    engine: app?.engine, profile: app?.profile, template: app?.template, filesystem: app?.fs.vfs,
    status: app?.status(), server: app?.server(), started: app?.started(), isolated: crossOriginIsolated, url: location.href };
}
async function snapshotServices() {
  const token = crypto.randomUUID();
  const services = Array.from(peers.values()).filter(peer => peer.services.size > 0);
  if (!services.length) throw Error("no actual service observation transport armed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(Error("service snapshot hang cap")), 60000);
      snapshots.set(token, { remaining: new Set(services.map(peer => peer.own.workerId)), done: resolve });
      for (const peer of services) peer.port.postMessage({ ...peer.own, payload: { command: "snapshot-service", token } });
    });
  } finally { snapshots.delete(token); clearTimeout(timer); }
}
async function drain() { await Promise.all(Array.from(pending)); }
async function gate(phase: string) {
  await snapshotServices();
  await drain();
  const response = await fetch("/gate", { method: "POST", body: JSON.stringify({ phase, raw: snapshot() }) });
  const result = await response.json();
  record({ kind: "gate-result", phase, result });
  if (!response.ok) throw Error(`entry gate ${phase}: ${result.error}`);
}
function rejectControls() {
  const peer = Array.from(peers.values()).find(peer => peer.services.size > 0);
  if (!peer) throw Error("no actual service peer for negative controls");
  for (const id of [{ runtimeId: "wrong-runtime-00000000-0000-0000-000000000000", workerId: peer.own.workerId }, { workerId: peer.own.workerId }, { runtimeId: capture, workerId: -1 }, { runtimeId: capture }]) {
    peer.port.postMessage({ ...id, payload: { command: "snapshot-service", token: "must-reject" } });
  }
}
Reflect.set(globalThis, "sandboxObserver", { snapshot, record, snapshotServices, drain, gate, rejectControls,
  registerRuntime(runtime: Runtime) {
    runtimeRegistrations++;
    if (selectedRuntime && selectedRuntime !== runtime) runtimeChanged = true;
    selectedRuntime ??= runtime;
    record({ kind: "original-runtime-registered", runtimeId: capture, runtimeRegistrations });
  },
  beginCommand(spec: Pick<EntryCommand, "id" | "args">) { commandId = spec.id; record({ kind: "original-command-started", commandId, spec }); },
});
record({ kind: "collector-installed", mode: new URLSearchParams(location.search).get("entryControls") ?? "off", createsRuntime: false, createsProcess: false });
