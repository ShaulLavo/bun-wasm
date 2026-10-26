import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import type { SharedObjects } from "../../../web/src/shared-objects/protocol";
import type { Channel, Codec, CodecHooks, Graph } from "./runtime-types";

export interface SourcePort {
  on(event: string, listener: (value: unknown) => void): void;
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
  close(): void;
}
interface PortsRuntime {
  MessageChannel: new() => { port1: SourcePort; port2: SourcePort };
  receiveMessageOnPort(port: SourcePort): { message: unknown } | undefined;
  initialize(): void;
  getEnvironmentData(key: unknown): unknown;
  BroadcastChannel: new(name: string) => { postMessage(value: unknown): void; close(): void };
  parentPort: SourcePort;
  workerData: SourcePort;
  __fixtureChild(channel: Channel, graph: Graph): void;
  __fixturePacket(port: SourcePort, sequence: number, graph: Graph): void;
}
const native = {
  base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
  base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
  transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
};
function factory(name: string, overlay?: (source: string) => string) {
  const path = new URL(`../../../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url);
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
export function sourceChannel(host: object): Channel {
  return factory("worker_channel")({ native: host, concatBytes: (arrays: Uint8Array[]) => Buffer.concat(arrays) }).open(3, 4);
}
function childOverlay(source: string) {
  const target = "return exports;";
  if (source.split(target).length !== 2) throw new Error("Fixture child hook is no longer unique");
  return source.replace(target, `return Object.assign(exports, {
    __fixtureChild(channel, graph) {
      children.set(0, { ref: true, send: frame => channel.send(frame), pump: () => channel.pump(incoming), watch: () => channel.subscriptions(), event() {} });
      claimTransferred(graph, [0]);
    },
    __fixturePacket(port, sequence, graph) { portOps.receivePacket(port, "port-data", sequence, graph); }
  });`);
}
export function sourcePorts(options: { sharedObjects?: SharedObjects; channel?: Channel; graph?: Graph } = {}) {
  let codec: Codec | undefined;
  let pump: (() => void) | undefined;
  const env = options.graph ? { BUNWASM_WORKER_INIT: JSON.stringify({ route: [0], envGroup: "fixture", argv: ["bun", "child.ts"], execArgv: [], graph: options.graph }), BUNWASM_WORKER_CONTROL: JSON.stringify({ input: 3, output: 4 }) } : {};
  const modules = new Map<string, unknown>([
    ["process", { env, execArgv: [], execPath: "bun", cwd: () => "/" }],
    ["events", EventEmitter], ["structured_clone", { structuredClone }], ["net", {}],
    ["worker_channel", { open: () => options.channel }],
    ["worker_codec", { create(hooks: CodecHooks) { codec = factory("worker_codec")({ native, sharedObjects: options.sharedObjects }).create(hooks); return codec; } }],
  ]);
  const lifecycle: Pick<BunWasm.Internal, "workerStartup" | "workerErrorData" | "clonePorts"> = {};
  const internal = Object.assign({
    native, realTimers: { setImmediate }, messagePortRefs: 0, sharedObjects: options.sharedObjects,
    require(name: string) { if (!modules.has(name)) throw new Error(`Unexpected module ${name}`); return modules.get(name); },
    builtin: () => ({ createRequire: () => () => { throw new Error("No fixture preloads"); } }),
    addIoWaiter() {},
    set workerPump(callback: () => void) { pump = callback; },
  }, lifecycle);
  const runtime: PortsRuntime = factory("worker_threads", childOverlay)(internal);
  if (!codec || !pump) throw new Error("Missing codec or pump");
  return Object.assign(runtime, { codec, pump, internal });
}
