import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import type { SharedObjects } from "../../../web/src/shared-objects/protocol";
import type { Channel, Codec, CodecHooks, Graph } from "./runtime-types";

export interface SourcePort {
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
  __fixturePacket(port: SourcePort, sequence: number, graph: Graph): void;
}
const native = {
  utf8Decode: (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8"),
  base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
  base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
  transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
};
function factory(name: string, overlay?: (source: string) => string, extension = "ts") {
  const path = new URL(`../../../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url);
  const input = readFileSync(path, "utf8");
  const source = overlay ? overlay(input) : input;
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__sharedFixture = ${source}`);
  const value: unknown = runInThisContext(emitted);
  if (typeof value !== "function") throw new Error(`Missing ${name} factory`);
  return value;
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
    __fixturePacket(port, sequence, graph) { portOps.receivePacket(port, "port-data", sequence, graph); }
  });`);
}
/**
 * Loads net.js into `internal`, which gives it the real waiter set, `addIoWaiter` and `pumpIo`.
 * Only what the module touches while loading is supplied; nothing here opens a socket.
 */
function sourceLoop(internal: { native: object; require(name: string): unknown; pumpIo?: () => boolean }, modules: Map<string, unknown>) {
  const unused = () => { throw new Error("No networking in this fixture"); };
  modules.set("http_common", { validateHeaderName: unused, validateHeaderValue: unused, validateMethod: unused, validatePath: unused, validateStatus: unused, outgoingHeaders: unused });
  modules.set("websocket", { clientClass: () => class {} });
  modules.set("net", factory("net", undefined, "js")(Object.assign(internal, { web: { Request, Response, Headers } })));
  const pumpIo = internal.pumpIo;
  if (!pumpIo) throw new Error("net.js installed no pumpIo");
  return { pumpIo };
}
export function sourcePorts(options: { sharedObjects?: SharedObjects | BunWasm.SharedObjects; channel?: Channel; graph?: Graph; route?: number[]; lanes?: { ledger: number; cell: [number, number] }; beforeDetach?: () => void; active?: () => boolean; realLoop?: boolean } = {}) {
  const runtimeNative = { ...native, transferArrayBuffers(buffers: ArrayBuffer[]) { options.beforeDetach?.(); native.transferArrayBuffers(buffers); } };
  let codec: Codec | undefined;
  let pump: (() => void) | undefined;
  // The runtime's own event-loop waiter, so a test can run real steps.
  let waiter: BunWasm.IoWaiter | undefined;
  const env = options.graph ? { BUNWASM_WORKER_INIT: JSON.stringify({ route: options.route ?? [0], envGroup: "fixture", argv: ["bun", "child.ts"], execArgv: [], graph: options.graph, lanes: options.lanes }), BUNWASM_WORKER_CONTROL: JSON.stringify({ input: 3, output: 4 }) } : {};
  const modules = new Map<string, unknown>([
    ["process", { env, execArgv: [], execPath: "bun", cwd: () => "/" }],
    ["events", EventEmitter], ["structured_clone", { structuredClone }], ["net", {}],
    ["worker_channel", { open: () => options.channel }],
    ["worker_codec", { create(hooks: CodecHooks) { codec = factory("worker_codec")({ native: runtimeNative, sharedObjects: options.sharedObjects }).create(hooks); return codec; } }],
  ]);
  const lifecycle: Pick<BunWasm.Internal, "workerStartup" | "workerErrorData" | "clonePorts"> = {};
  const internal = Object.assign({
    native: runtimeNative,
    realTimers: { setImmediate(callback: () => void) { return setImmediate(() => { if (options.active?.() !== false) callback(); }); } }, messagePortRefs: new Set<object>(), sharedObjects: options.sharedObjects,
    require(name: string) { if (!modules.has(name)) throw new Error(`Unexpected module ${name}`); return modules.get(name); },
    builtin: () => ({ createRequire: () => () => { throw new Error("No fixture preloads"); } }),
    addIoWaiter(value: BunWasm.IoWaiter) { waiter = value; return value; },
    set workerPump(callback: () => void) { pump = callback; },
  }, lifecycle);
  // The runtime's own I/O loop (net.js): its waiter set and the pumpIo the engine driver calls.
  const loop = options.realLoop ? sourceLoop(internal, modules) : undefined;
  const runtime: PortsRuntime = factory("worker_threads", childOverlay)(internal);
  if (!codec || !pump) throw new Error("Missing codec or pump");
  /** One ordinary event-loop step of this runtime's waiter, housekeeping included. */
  const step = () => waiter?.step();
  /** One pass of the real I/O loop over every registered waiter, as the driver runs it. */
  const pumpIo = () => { if (!loop) throw new Error("This runtime was made without the real loop"); return loop.pumpIo(); };
  return Object.assign(runtime, { codec, pump, step, pumpIo, internal });
}
