import { observeFilesystemEndpoint, type EndpointSnapshot } from "./storage-fs-endpoint";
import type { FilesystemConnection } from "../web/node_modules/waffle/fs/protocol";
import { workerProcessState } from "../web/node_modules/waffle/proc/worker-client";
import type { RuntimeWorkerRequest } from "../web/node_modules/waffle/browser/worker";

const handshake = "bunwasm-storage-first-event-v1";
const metadataPrefix = "[storage-fs-metadata] ";
const prefix = "[storage-fs-first-event] ";
const logFailure = console.error.bind(console);
function evidenceFailure(error: unknown): void { logFailure("[storage-fs-observation-error] " + String(error)); }
function observing(operation: () => void): void {
  try { operation(); } catch (error) { evidenceFailure(error); }
}
const observers = new WeakMap<FilesystemConnection, ReturnType<typeof observeFilesystemEndpoint>>();
const runtimes = new WeakMap<object, string>();
const trees = new WeakMap<SharedArrayBuffer, string>();
const documentId = crypto.randomUUID();
let association: Association | undefined;
let processIdentity: object | null = null;
let writer: ((row: object) => void) | undefined;
type Association = { documentId: string; runtimeId: string; workerId: number; pageURL: string };
export function validAssociation(value: unknown): value is Association {
  if (!value || typeof value !== "object") return false;
  return "documentId" in value && typeof value.documentId === "string" && value.documentId.length === 36
    && "runtimeId" in value && typeof value.runtimeId === "string" && value.runtimeId.length === 36
    && "workerId" in value && Number.isSafeInteger(value.workerId) && Number(value.workerId) > 0
    && "pageURL" in value && typeof value.pageURL === "string" && value.pageURL.startsWith("http");
}

export function observeProcess(request: RuntimeWorkerRequest, entry: string): void {
  if (!association || !request.runtimeProcess) return;
  const transport = request.runtimeProcess;
  observing(() => {
    const state = workerProcessState(transport);
    processIdentity = { entry, pid: state.pid, parentPid: state.parentPid, processGeneration: transport.generation };
  });
}
export function associateFilesystem(root: SharedArrayBuffer, alias: SharedArrayBuffer): void {
  if (!writer) return;
  const id = trees.get(root);
  if (!id) { evidenceFailure(Error("Unobserved original filesystem")); return; }
  const previous = trees.get(alias);
  if (previous && previous !== id) { evidenceFailure(Error("Filesystem alias changed runtime")); return; }
  trees.set(alias, id);
}
export function bindRuntime(runtime: object, shared: SharedArrayBuffer): void {
  if (!writer) return;
  const runtimeId = trees.get(shared);
  if (!runtimeId) { evidenceFailure(Error("Runtime has no observed original filesystem")); return; }
  const existing = runtimes.get(runtime);
  if (existing && existing !== runtimeId) { evidenceFailure(Error("Runtime changed filesystem identity")); return; }
  runtimes.set(runtime, runtimeId);
  writer({ kind: "actual-runtime-bound", documentId, runtimeId, pageURL: location.href });
}
export function observePreview1Branch(interactive: boolean): void {
  if (processIdentity) processIdentity = { ...processIdentity, executorBranch: interactive ? "terminal" : "plain" };
}
function record(snapshot: EndpointSnapshot): void {
  writer?.({ ...association, workerURL: location.href, moduleURL: import.meta.url, process: processIdentity, snapshot });
}
export function observeEndpoint(connection: FilesystemConnection, endpoint: "client" | "service"): void {
  if (!writer || observers.has(connection)) return;
  if (!association) {
    let runtimeId = trees.get(connection.shared);
    if (!runtimeId) { runtimeId = crypto.randomUUID(); trees.set(connection.shared, runtimeId); }
    const pageAssociation = { documentId, runtimeId, workerId: null, pageURL: location.href };
    install(connection, endpoint, snapshot => writer?.({ ...pageAssociation, workerURL: null, moduleURL: import.meta.url, process: null, snapshot }));
    return;
  }
  install(connection, endpoint, record);
}
function install(connection: FilesystemConnection, endpoint: "client" | "service", emit: (snapshot: EndpointSnapshot) => void): void {
  observing(() => installObserved(connection, endpoint, emit));
}
function installObserved(connection: FilesystemConnection, endpoint: "client" | "service", emit: (snapshot: EndpointSnapshot) => void): void {
  const observer = observeFilesystemEndpoint(connection, { tree: "ordinary-storage", realm: association ? "worker" : "page-root", endpoint, workerURL: location.href }, afterHandler => {
    const publish = () => observing(() => emit(observer.snapshot()));
    if (afterHandler) queueMicrotask(publish);
    else publish();
  }, evidenceFailure);
  observers.set(connection, observer);
  const initial = observer.snapshot();
  if (!initial.first) emit(initial);
}
export function qualifyEndpoint(connection: FilesystemConnection): void { observing(() => observers.get(connection)?.qualifyHandlers()); }
export function checkEndpoint(connection: FilesystemConnection): void { observing(() => { observers.get(connection)?.snapshot(); }); }

/** The original worker's start message and handlers keep their receiver and argument tuple. */
export function installWorker(): void {
  globalThis.addEventListener("message", event => {
    if (event.data?.diagnostic !== handshake) return;
    event.stopImmediatePropagation();
    if (association || !validAssociation(event.data) || event.ports.length !== 1) { evidenceFailure(Error("Invalid storage observation identity")); return; }
    const own = { documentId: event.data.documentId, runtimeId: event.data.runtimeId, workerId: event.data.workerId, pageURL: event.data.pageURL };
    association = own;
    const port = event.ports[0]!;
    const post = port.postMessage.bind(port);
    writer = row => post({ ...own, row });
  });
}

export function installPage(): void {
  if (Reflect.get(globalThis, "__bunwasmStorageFirstEvent") !== true) return;
  const retention = { recent: [], causalEvents: 0, propagationEvents: 0, causalKeys: new Set<string>() };
  const output = console.debug.bind(console);
  writer = row => {
    output(metadataPrefix + JSON.stringify(row));
    retain(row, retention, value => output(prefix + JSON.stringify(value)));
  };
  const NativeWorker = globalThis.Worker;
  const nativePost = NativeWorker.prototype.postMessage;
  const nativeTerminate = NativeWorker.prototype.terminate;
  Reflect.set(globalThis, "__bunwasmStorageFirstEventSnapshot", () => retention.recent.slice());
  let workerId = 0;
  globalThis.Worker = class extends NativeWorker {
    private observationPort: MessagePort | undefined;
    private readonly observationId = ++workerId;
    private posted: object | null = null;
    private own: Association | undefined;
    private readonly observationURL: string;
    constructor(...args: ConstructorParameters<typeof NativeWorker>) {
      super(...args);
      this.observationURL = new URL(String(args[0]), location.href).href;
      this.addEventListener("message", event => {
        if (event.data?.type !== "exit" && event.data?.type !== "error") return;
        if (!this.own) return;
        writer?.({ kind: "native-outcome", ...this.own, workerId: this.observationId, workerURL: this.observationURL, posted: this.posted, type: event.data.type, code: event.data.code });
      });
    }
    override postMessage(...args: [message: unknown, options?: Transferable[] | StructuredSerializeOptions]) {
      const message = args[0];
      if (!this.observationPort) observing(() => this.attach(message));
      if (message && typeof message === "object" && "runtimeProcess" in message && "filesystem" in message) observing(() => { this.posted = postedIdentity(message); });
      return Reflect.apply(nativePost, this, args);
    }
    private attach(message: unknown): void {
      const runtimeId = treeOf(message);
      if (!runtimeId) return;
      const own = { documentId, runtimeId, workerId: this.observationId, pageURL: location.href };
      this.own = own;
      const pair = new MessageChannel();
      this.observationPort = pair.port1;
      const write = writer!;
      pair.port1.onmessage = event => observing(() => receive(event.data, own, write));
      Reflect.apply(nativePost, this, [{ diagnostic: handshake, ...own }, [pair.port2]]);
    }
    override terminate(): void {
      this.observationPort?.close();
      return Reflect.apply(nativeTerminate, this, []);
    }
  };
}
function postedIdentity(message: object): object | null {
  if (!("runtimeProcess" in message) || !message.runtimeProcess || typeof message.runtimeProcess !== "object") return null;
  if (!("filesystem" in message) || !message.filesystem || typeof message.filesystem !== "object") return null;
  const fs = message.filesystem;
  const process = message.runtimeProcess;
  if (!("owner" in fs) || !("requests" in fs) || !fs.requests || typeof fs.requests !== "object" || !("generation" in fs.requests)) return null;
  if (!("pid" in process) || !("generation" in process)) return null;
  return { owner: fs.owner, generation: fs.requests.generation, pid: process.pid, processGeneration: process.generation };
}
function treeOf(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return;
  const connection = "filesystem" in message ? message.filesystem : "connect" in message ? message.connect : undefined;
  if (!connection || typeof connection !== "object" || !("shared" in connection) || !(connection.shared instanceof SharedArrayBuffer)) return;
  return trees.get(connection.shared);
}
export function receive(value: unknown, own: Association, write: (row: object) => void): void {
  if (!validAssociation(value) || value.documentId !== own.documentId || value.runtimeId !== own.runtimeId || value.workerId !== own.workerId || value.pageURL !== own.pageURL) throw Error("Storage observation peer identity mismatch");
  if (!("row" in value) || !value.row || typeof value.row !== "object") throw Error("Storage observation has no row");
  const row = value.row;
  if (!validAssociation(row) || row.documentId !== own.documentId || row.runtimeId !== own.runtimeId || row.workerId !== own.workerId || row.pageURL !== own.pageURL) throw Error("Storage observation row identity mismatch");
  write(row);
}
export type Retention = { recent: object[]; causalEvents: number; propagationEvents: number; causalKeys: Set<string> };
export function retain(row: object, state: Retention, emit: (value: object) => void): void {
  state.recent.push(row);
  if (state.recent.length > 32) state.recent.shift();
  if (!("snapshot" in row) || !row.snapshot || typeof row.snapshot !== "object") return;
  if (!("first" in row.snapshot) || !row.snapshot.first || typeof row.snapshot.first !== "object") return;
  const first = row.snapshot.first;
  const local = "kind" in first && (first.kind === "messageerror" || first.kind === "send-error");
  if (!local || !("closedBefore" in first) || first.closedBefore !== null) { state.propagationEvents++; return; }
  if (state.causalEvents >= 17) return;
  const key = JSON.stringify(["documentId" in row ? row.documentId : null, "runtimeId" in row ? row.runtimeId : null, "workerId" in row ? row.workerId : null, "endpoint" in row.snapshot ? row.snapshot.endpoint : null, "owner" in row.snapshot ? row.snapshot.owner : null, "generation" in row.snapshot ? row.snapshot.generation : null, "sequence" in first ? first.sequence : null]);
  if (state.causalKeys.has(key)) return;
  state.causalKeys.add(key);
  state.causalEvents++;
  if (state.causalEvents === 17) {
    emit({ kind: "causal-overflow", truncated: true, causalEventsAtLeast: 17, droppedAtLeast: 1, limits: { recent: 32, causalEmissions: 16 } });
    return;
  }
  emit({ firstObservation: row, recent: state.recent.slice(), limits: { recent: 32, causalEmissions: 16 }, truncated: false, initiatingCauseProved: false });
}
