import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { runInThisContext } from "node:vm";
import type { SharedObjects } from "../../../web/src/shared-objects/protocol";
import type { Channel, Codec, CodecHooks, Graph } from "./runtime-types";
import type { ImmediateQueue } from "../../../crates/bunwasm-runtime/src/js/immediate_queue-types";

export interface SourcePort extends EventTarget {
  on(event: string, listener: (value: unknown) => void): void;
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
  close(): void;
  ref(): void;
  unref(): void;
  hasRef(): boolean;
}
interface PortsRuntime {
  MessagePort: { new(...args: never[]): SourcePort };
  MessageChannel: new() => { port1: SourcePort; port2: SourcePort };
  receiveMessageOnPort(port: SourcePort): { message: unknown } | undefined;
  initialize(): void;
  getEnvironmentData(key: unknown): unknown;
  BroadcastChannel: new(name: string) => { postMessage(value: unknown): void; close(): void; ref(): unknown; unref(): unknown };
  parentPort: SourcePort;
  workerData: SourcePort;
  __fixtureShutdown(): void;
  __fixtureChild(channel: Channel, graph: Graph, id?: number): void;
  /** Port ids the root's broker still has a record for. */
  __fixtureOwners(): string[];
  /** Sets the last commit nonce this thread took, to reach the end of the range. */
  __fixtureNonces(value: number): void;
  __fixturePacket(port: SourcePort, sequence: number, graph: Graph): void;
}
const native = {
  utf8Decode: (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8"),
  base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
  base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
  transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
};
function factory(name: string, overlay?: (source: string) => string, extension = "ts", bindings?: Record<string, unknown>) {
  const path = new URL(`../../../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url);
  const input = readFileSync(path, "utf8");
  const source = (overlay ? overlay(input) : input).trim().replace(/;$/, "");
  const expression = bindings ? `(function(${Object.keys(bindings).join(",")}) { return (\n${source}\n); })` : source;
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__sharedFixture = ${expression}`);
  const evaluate: unknown = runInThisContext(emitted);
  if (typeof evaluate !== "function") throw new Error(`Missing ${name} evaluator`);
  const value: unknown = bindings ? Reflect.apply(evaluate, undefined, Object.values(bindings)) : evaluate;
  if (typeof value !== "function") throw new Error(`Missing ${name} factory`);
  return value;
}
/** Real web and events factories share the broker consumer's realm without replacing host globals. */
function sourceWeb() {
  const globals: Record<string, unknown> = {};
  const internal = {
    native: { ...native, utf8Encode: (value: string) => new TextEncoder().encode(value),
      timeOrigin: () => performance.timeOrigin, now: () => performance.now(), platformInfo: { version: Bun.version, arch: process.arch } },
    nextTick: (callback: () => void) => queueMicrotask(callback),
    web: { Event, EventTarget, AbortController, AbortSignal },
    require(name: string): unknown {
      if (name === "text_decoder") return TextDecoder;
      if (name === "web_brand") return factory(name);
      if (name === "url_search_params") return factory(name)(internal);
      if (name === "inspect") return { nodeInspect: inspect };
      if (name === "streams" || name === "body_streams") return {};
      throw new Error(`Unexpected web module ${name}`);
    },
  };
  factory("web", undefined, "js")(internal)((name: string, value: unknown) => { globals[name] = value; }, () => {});
  const events = factory("events", undefined, "ts", globals)(internal);
  return { internal, events, globals };
}
export function sourceCodec(sharedObjects?: SharedObjects, hooks?: CodecHooks): Codec {
  return factory("worker_codec")({ native, sharedObjects }).create({ sharedObjects, ...(hooks ?? {
    isPort: () => false,
    prepare() { throw new Error("Unexpected port transfer"); },
    restore() { throw new Error("Unexpected port restore"); },
    activate() {},
  }) });
}
export function sourceV8(sharedObjects: SharedObjects): { serialize(value: unknown): Uint8Array; deserialize(value: Uint8Array): unknown } {
  const internal = { native, sharedObjects, require(name: string) {
    if (name === "buffer") return { Buffer };
    if (name === "worker_codec") return factory(name)(internal);
    throw new Error(`Unexpected module ${name}`);
  } };
  return factory("v8")(internal);
}
/** The runtime's own group-lane wrapper over a set of lane natives. */
export function sourceLanes(wasm: object): BunWasm.GroupLanes {
  return factory("worker_lane")({ native: { wasm } });
}
/** One guest's worker_channel module: every channel it opens shares the module's state, as in a real guest. */
export function sourceChannels(host: object): { open(input: number, output: number): Channel } {
  return factory("worker_channel")({ native: host, concatBytes: (arrays: Uint8Array[]) => Buffer.concat(arrays) });
}
export function sourceChannel(host: object): Channel {
  return factory("worker_channel")({ native: host, concatBytes: (arrays: Uint8Array[]) => Buffer.concat(arrays) }).open(3, 4);
}
function childOverlay(source: string) {
  const target = "return exports;";
  if (source.split(target).length !== 2) throw new Error("Fixture child hook is no longer unique");
  return source.replace(target, `return Object.assign(exports, {
    __fixtureShutdown() { for (const port of Array.from(localPorts.values())) portOps.discard(port); },
    __fixtureChild(channel, graph, id = 0) {
      children.set(id, { ref: true, send: frame => channel.send(frame), pump: () => channel.pump(incoming), watch: () => channel.subscriptions(), event() {} });
      claimTransferred(graph, [id]);
    },
    __fixtureOwners() { return Array.from(owners.keys()); },
    __fixtureNonces(value) { nonces = value; },
    __fixturePacket(port, sequence, graph) { portOps.receivePacket(port, "port-data", sequence, graph); }
  });`);
}
/**
 * Loads net.js into `internal`, which gives it the real waiter set, `addIoWaiter` and `pumpIo`.
 * Only what the module touches while loading is supplied; nothing here opens a socket.
 */
function sourceLoop(internal: { native: object; web: object; require(name: string): unknown; pumpIo?: () => boolean }, modules: Map<string, unknown>) {
  const unused = () => { throw new Error("No networking in this fixture"); };
  modules.set("http_common", { validateHeaderName: unused, validateHeaderValue: unused, validateMethod: unused, validatePath: unused, validateStatus: unused, outgoingHeaders: unused });
  modules.set("websocket", { clientClass: () => class {} });
  modules.set("io_pump", factory("io_pump")(internal));
  Object.assign(internal.web, { Request, Response, Headers });
  modules.set("net", factory("net", undefined, "js")(internal));
  const pumpIo = internal.pumpIo;
  if (!pumpIo) throw new Error("net.js installed no pumpIo");
  return { pumpIo };
}
/** The core natives the engine's transfer native calls itself. */
type CommitNatives = Pick<BunWasm.WasmNative, "laneCommitCheck" | "laneCommitStaged">;
/**
 * `beforeTransfer` runs on entry to a lane post's transfer call and may throw, as an engine may
 * on entering any call. `beforeDetach` runs at the point after which the real native runs no
 * JavaScript. `settled` counts `transferSettled` calls.
 */
export interface TransferHooks { beforeTransfer?: () => void; beforeDetach?: () => void; settled?: () => void; }
/**
 * A stand-in for the engine's transfer native (crates/bunwasm-engine-quickjs/src/transfer.rs),
 * in its order: the detach predicate on every buffer, the core's commit check, then the
 * detaches and the commit with nothing between them. A refusal throws what `refuse` makes.
 */
function transferNative(hooks: TransferHooks, core?: CommitNatives) {
  return function transferArrayBuffers(buffers: ArrayBuffer[], slot?: number, generation?: number, side?: number, high?: number, low?: number, refuse?: (message: string) => unknown) {
    if (slot === undefined || generation === undefined || side === undefined || high === undefined || low === undefined) {
      hooks.beforeDetach?.(); native.transferArrayBuffers(buffers);
      return;
    }
    hooks.beforeTransfer?.();
    if (!core) throw new TypeError("MessagePort lanes are not available");
    const refused = (message: string) => refuse ? refuse(message) : new DOMException(message, "DataCloneError");
    if (buffers.some(buffer => !(buffer instanceof ArrayBuffer) || buffer.detached)) throw refused("ArrayBuffer is not detachable");
    if (core.laneCommitCheck(slot, generation, side, high, low) < 0) throw refused("MessagePort changed during transfer");
    hooks.beforeDetach?.();
    native.transferArrayBuffers(buffers);
    core.laneCommitStaged(slot, generation, side, high, low);
  };
}
type SourceImmediate = { callback: () => void; active: boolean };
function dispatchImmediate(queue: ImmediateQueue<SourceImmediate>, active?: () => boolean) {
  for (let immediate = queue.shift(); immediate; immediate = queue.shift()) {
    if (!immediate.active) continue;
    if (active?.() !== false) immediate.callback();
    return;
  }
}
function enqueueImmediate(queue: ImmediateQueue<SourceImmediate>, state: { pending: number }, wake: () => void, callback: () => void, selected: boolean) {
  const immediate = { callback, active: true };
  try {
    if (selected) queue.pushFront(immediate);
    else queue.push(immediate);
    state.pending++;
    setImmediate(wake);
    return immediate;
  } catch (error) {
    if (selected) immediate.active = false;
    throw error;
  }
}
function sourceImmediateClock(active?: () => boolean) {
  const Constructor = factory("immediate_queue")();
  const queue: ImmediateQueue<SourceImmediate> = new Constructor();
  const state = { pending: 0 };
  const wake = () => { state.pending--; dispatchImmediate(queue, active); };
  return {
    Constructor,
    timers: {
      setImmediate(callback: () => void) { return enqueueImmediate(queue, state, wake, callback, false); },
      queueSelectedTask(callback: () => void) { return enqueueImmediate(queue, state, wake, callback, true); },
    },
    pending: () => state.pending,
    queued: () => queue.length,
  };
}
export function sourcePorts(options: { sharedObjects?: SharedObjects | BunWasm.SharedObjects; channel?: Channel; graph?: Graph; route?: number[]; lanes?: { ledger: number; cell: [number, number] }; active?: () => boolean; realLoop?: boolean; core?: CommitNatives } & TransferHooks = {}) {
  const source = sourceWeb();
  const runtimeNative = { ...native, transferArrayBuffers: transferNative(options, options.core), transferSettled() { options.settled?.(); } };
  let codec: Codec | undefined;
  let pump: (() => void) | undefined;
  // The runtime's own event-loop waiter, so a test can run real steps.
  let waiter: BunWasm.IoWaiter | undefined;
  const env = options.graph ? { BUNWASM_WORKER_INIT: JSON.stringify({ route: options.route ?? [0], envGroup: "fixture", argv: ["bun", "child.ts"], execArgv: [], graph: options.graph, lanes: options.lanes }), BUNWASM_WORKER_CONTROL: JSON.stringify({ input: 3, output: 4 }) } : {};
  const modules = new Map<string, unknown>([
    ["process", { env, execArgv: [], execPath: "bun", cwd: () => "/" }],
    ["events", source.events], ["structured_clone", { structuredClone }], ["net", {}],
    ["worker_channel", { open: () => options.channel }],
    ["worker_codec", { create(hooks: CodecHooks) { codec = factory("worker_codec")({ native: runtimeNative, sharedObjects: options.sharedObjects }).create(hooks); return codec; } }],
  ]);
  const lifecycle: Pick<BunWasm.Internal, "workerStartup" | "workerErrorData" | "clonePorts" | "workerExit"> = {};
  const clock = sourceImmediateClock(options.active);
  modules.set("immediate_queue", clock.Constructor);
  const runtimeInternal = {
    native: runtimeNative,
    realTimers: clock.timers, messagePortRefs: new Set<object>(), sharedObjects: options.sharedObjects,
    require(name: string) { if (!modules.has(name)) throw new Error(`Unexpected module ${name}`); return modules.get(name); },
    builtin: () => ({ createRequire: () => () => { throw new Error("No fixture preloads"); } }),
    addIoWaiter(value: BunWasm.IoWaiter) { waiter = value; return value; },
    set workerPump(callback: () => void) { pump = callback; },
  };
  const internal = Object.assign(source.internal, runtimeInternal, lifecycle);
  Object.defineProperties(internal, Object.getOwnPropertyDescriptors(runtimeInternal));
  // The runtime's own I/O loop (net.js): its waiter set and the pumpIo the engine driver calls.
  const loop = options.realLoop ? sourceLoop(internal, modules) : undefined;
  const runtime: PortsRuntime = factory("worker_threads", childOverlay, "ts", { ...source.globals, URL })(internal);
  if (!codec || !pump) throw new Error("Missing codec or pump");
  /** One ordinary event-loop step of this runtime's waiter, housekeeping included. */
  const step = () => waiter?.step();
  /** One pass of the real I/O loop over every registered waiter, as the driver runs it. */
  const pumpIo = () => { if (!loop) throw new Error("This runtime was made without the real loop"); return loop.pumpIo(); };
  return Object.assign(runtime, { codec, pump, step, pumpIo, internal,
    pendingImmediateCallbacks: clock.pending,
    queuedImmediateTasks: clock.queued,
  });
}
