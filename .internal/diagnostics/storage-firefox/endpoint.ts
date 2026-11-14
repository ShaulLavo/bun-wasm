import { observeFilesystemEndpoint } from "./upstream-observer.ts";
import { requestTransportError } from "../../../sandbox/node_modules/waffle/fs/request-memory.ts";
import { workerProcessState } from "../../../sandbox/node_modules/waffle/proc/worker-client.ts";
import type { FilesystemConnection } from "../../../sandbox/node_modules/waffle/fs/protocol.ts";
import type { RuntimeWorkerRequest, WorkerExecutor } from "../../../sandbox/node_modules/waffle/browser/worker.ts";

import { workerTransport } from "./worker-transport.ts";
const channel = workerTransport(self as unknown as DedicatedWorkerGlobalScope);
const scope = self as unknown as DedicatedWorkerGlobalScope;
const sessions = new Map<number, ReturnType<typeof install>>();
function install(connection: FilesystemConnection, endpoint: "client" | "service", extra: object) {
  const observer = observeFilesystemEndpoint(connection, { tree: "native-entry", realm: `native-${endpoint}`, endpoint, workerURL: self.location.href });
  const inheritedSegments = Array.from(connection.segments, (buffer, index) => buffer ? ({ index: index + 1, bytes: buffer.byteLength, maximum: buffer.maxByteLength, growable: buffer.growable }) : null);
  const emit = (stage: string, detail: object = {}) => channel.postMessage({ stage, moduleURL: import.meta.url, workerIsolated: scope.crossOriginIsolated, ...extra, ...detail, snapshot: observer.snapshot() });
  connection.port.addEventListener("messageerror", () => queueMicrotask(() => emit("after-local-messageerror")));
  connection.port.addEventListener("message", event => {
    if (event.data?.segment) emit("segment-received", { segment: { index: event.data.segment, bytes: event.data.buffer?.byteLength, maximum: event.data.buffer?.maxByteLength, growable: event.data.buffer?.growable, inherited: !!inheritedSegments[event.data.segment - 1] } });
    if (event.data?.transportClosed) queueMicrotask(() => emit("after-transportClosed"));
  });
  emit("before-original-handlers", { inheritedSegments, maximumFilesystemBytes: connection.maxBytes, requestBacking: { bytes: connection.requests.data.byteLength, maximum: connection.requests.data.maxByteLength, growable: connection.requests.data.growable } });
  return { connection, observer, emit };
}

export function observeClient(request: RuntimeWorkerRequest, entry: "bun" | "shell") {
  const state = request.runtimeProcess ? workerProcessState(request.runtimeProcess) : undefined;
  const session = install(request.filesystem, "client", { entry, commandId: request.env.QUALIFY_COMMAND_ID ?? null, args: request.args, qualificationEnvironment: Object.fromEntries(Object.entries(request.env).filter(([key]) => key === "QUALIFY_TARGET" || key === "QUALIFY_FAULT")), pid: state?.pid ?? null, parentPid: state?.parentPid ?? null, processGeneration: request.runtimeProcess?.generation ?? null });
  currentClient = session;
  const mode = request.env.QUALIFY_TARGET === entry ? request.env.QUALIFY_FAULT : "none";
  return { ...session, mode };
}

type EntrySession = ReturnType<typeof observeClient>;
type EntryState = { preopenCalls: number; instantiateReached: boolean; instantiated: boolean; guestEntry: boolean };
type Setup<R extends RuntimeWorkerRequest> = Parameters<NonNullable<WorkerExecutor<R>["setup"]>>;
type Instantiated<R extends RuntimeWorkerRequest> = Parameters<NonNullable<WorkerExecutor<R>["instantiated"]>>;
function stateOf(state: EntryState, session: EntrySession) { return { ...state, faultLabel: session.mode }; }
function watchPreopen<R extends RuntimeWorkerRequest>(fs: Setup<R>[0]["fs"], state: EntryState, session: EntrySession) {
  const original = fs.preopen;
  fs.preopen = function (...args) {
    state.preopenCalls++;
    const before = session.observer.snapshot().requestSends;
    session.emit("before-original-preopen", stateOf(state, session));
    try { return Reflect.apply(original, this, args); }
    finally { session.emit("after-original-preopen", { ...stateOf(state, session), posts: session.observer.snapshot().requestSends - before }); }
  };
}
function watchLaunch<R extends RuntimeWorkerRequest>(wasi: Instantiated<R>[0]["wasi"], state: EntryState, session: EntrySession) {
  const launch = wasi.launch;
  wasi.launch = function (...args) {
    state.guestEntry = true;
    session.emit("before-original-guest-entry", stateOf(state, session));
    return Reflect.apply(launch, this, args);
  };
}
function setupHook<R extends RuntimeWorkerRequest>(executor: WorkerExecutor<R>, session: EntrySession, state: EntryState) {
  return (...args: Setup<R>) => {
    if (executor.setup) Reflect.apply(executor.setup, executor, args);
    session.observer.qualifyHandlers();
    session.emit("original-handlers-qualified", stateOf(state, session));
    watchPreopen(args[0].fs, state, session);
    if (session.mode === "client") session.connection.port.dispatchEvent(new MessageEvent("messageerror"));
    if (session.mode === "service") waitForServiceFault(session);
    session.emit("before-wasi", stateOf(state, session));
  };
}
function instantiatedHook<R extends RuntimeWorkerRequest>(executor: WorkerExecutor<R>, session: EntrySession, state: EntryState) {
  return async (...args: Instantiated<R>) => {
    state.instantiated = true;
    session.emit("original-instantiated", stateOf(state, session));
    watchLaunch(args[0].wasi, state, session);
    if (executor.instantiated) return Reflect.apply(executor.instantiated, executor, args);
  };
}
export function wrapExecutor<R extends RuntimeWorkerRequest>(executor: WorkerExecutor<R>, session: EntrySession): WorkerExecutor<R> {
  const state = { preopenCalls: 0, instantiateReached: false, instantiated: false, guestEntry: false };
  return {
    ...executor,
    setup: setupHook(executor, session, state),
    instantiated: instantiatedHook(executor, session, state),
    imports(...args) {
      state.instantiateReached = true;
      session.emit("before-original-instantiate", stateOf(state, session));
      return executor.imports ? Reflect.apply(executor.imports, executor, args) : args[0];
    },
    beforeFinish(...args) {
      session.emit("before-original-finish", stateOf(state, session));
      if (executor.beforeFinish) return Reflect.apply(executor.beforeFinish, executor, args);
    },
  };
}

function waitForServiceFault(session: ReturnType<typeof observeClient>) {
  channel.postMessage({ command: "fault-service", owner: session.connection.owner, generation: session.connection.requests.generation });
  const deadline = Date.now() + 60000;
  const word = new Int32Array(session.connection.requests.control);
  while (!requestTransportError(session.connection.requests)) {
    if (Date.now() >= deadline) throw new Error("labelled service fault did not acknowledge closure");
    Atomics.wait(word, 1, 0, 10);
  }
}

export function installServicePrelude() {
  scope.addEventListener("message", event => {
    if (!event.data?.connect) return;
    const connection: FilesystemConnection = event.data.connect;
    sessions.set(connection.owner, install(connection, "service", { mode: event.data.mode, implementation: event.data.implementation }));
  });
  const send = scope.postMessage;
  scope.postMessage = function (this: DedicatedWorkerGlobalScope, ...args: [message: unknown, options?: Transferable[] | StructuredSerializeOptions]) {
    const message = args[0];
    if (message && typeof message === "object" && "type" in message && message.type === "filesystem-state" && "status" in message && message.status === "ready") qualifyServices();
    return Reflect.apply(send, this, args);
  };
  channel.addEventListener("message", event => {
    if (event.data?.command === "snapshot-service") {
      for (const session of sessions.values()) session.emit("service-snapshot");
      channel.postMessage({ kind: "service-snapshot-complete", token: event.data.token, workerURL: self.location.href });
    }
    if (event.data?.command !== "fault-service") return;
    if (typeof event.data.owner !== "number" || typeof event.data.generation !== "number") throw Error("invalid diagnostic service identity");
    const session = sessions.get(event.data.owner);
    if (!session || session.connection.requests.generation !== event.data.generation) throw new Error("fault has no matching actual service endpoint");
    session.observer.qualifyHandlers();
    session.emit("before-labelled-service-fault", { faultLabel: "service" });
    session.connection.port.dispatchEvent(new MessageEvent("messageerror"));
    session.emit("after-labelled-service-fault", { faultLabel: "service" });
  });
}
function qualifyServices() {
  for (const session of sessions.values()) {
    session.observer.qualifyHandlers();
    session.emit("service-original-handlers-qualified");
  }
}

let currentClient: ReturnType<typeof install> | undefined;
export function browserExecutorEntry(request: RuntimeWorkerRequest & { engine: string }) {
  currentClient?.emit("original-browser-host-entry", { engine: request.engine, args: request.args });
}
