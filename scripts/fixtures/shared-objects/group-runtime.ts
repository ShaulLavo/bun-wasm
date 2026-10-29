// A shared-group QuickJS process's worker runtime (the real worker_threads, worker_codec and
// group_shared_objects sources) over a fake memory group held in one SharedArrayBuffer, so a
// parent and a child on two real threads see the same pin ownership the host enforces.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createContext, runInContext } from "node:vm";

const root = new URL("../../../crates/bunwasm-runtime/src/js/", import.meta.url);
const sources = new Map<string, string>();
function source(name: string) {
  let text = sources.get(name);
  if (!text) {
    text = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${readFileSync(new URL(`${name}.ts`, root), "utf8")}`);
    sources.set(name, text);
  }
  return text;
}

/** Fake group words. One region and one pin; owners are pids, as in bunwasm-host `shm.rs`. */
export const PIN_OWNER = 0, CHILD_STAGE = 1;
const FRAMES = 2, FRAME_BYTES = 3, FRAME_DATA = 16;
/** CHILD_STAGE: 1 when the child first tried to accept, 2 when it first blocked for a frame. */
const STAGE_ACCEPT = 1;
export const STAGE_WAITING = 2;
const PIN = 7, EBADF = 8;

export interface Group { readonly words: Int32Array; readonly region: SharedArrayBuffer }

export interface Threads {
  readonly workerData: unknown;
  initialize(): void;
  Worker: new (filename: string, options: object) => EventEmitter & { postMessage(value: unknown): void };
}

/** The group natives of process `pid`: one pin over the region; accept requires ownership. */
function natives(group: Group, pid: number) {
  const { words, region } = group;
  return {
    shmPin(buffer: SharedArrayBuffer) {
      if (buffer !== region) throw new Error("only the group region is pinned in this fixture");
      Atomics.store(words, PIN_OWNER, pid);
      return PIN;
    },
    shmRoute(pin: number, to: number) {
      if (pin !== PIN || Atomics.compareExchange(words, PIN_OWNER, pid, to) !== pid) throw new DOMException(`routing failed in the memory group (errno ${EBADF})`, "DataCloneError");
      return 0;
    },
    shmUnpin(pin: number) { if (pin === PIN) Atomics.store(words, PIN_OWNER, 0); return 0; },
    shmAccept(pin: number) {
      if (Atomics.load(words, CHILD_STAGE) === 0) { Atomics.store(words, CHILD_STAGE, STAGE_ACCEPT); Atomics.notify(words, CHILD_STAGE); }
      if (pin !== PIN || Atomics.compareExchange(words, PIN_OWNER, pid, 0) !== pid) throw new DOMException(`SharedArrayBuffer receipt failed in the memory group (errno ${EBADF})`, "DataCloneError");
      return region;
    },
  };
}

/** Parent -> child control pipe in group words: the child blocks until a frame is written. */
export function sendFrame(words: Int32Array, frame: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(frame) + "\n");
  new Uint8Array(words.buffer, FRAME_DATA * 4, bytes.length).set(bytes);
  Atomics.store(words, FRAME_BYTES, bytes.length);
  Atomics.add(words, FRAMES, 1);
  Atomics.notify(words, FRAMES);
}

function childChannel(words: Int32Array) {
  let read = 0;
  return {
    send() {}, drain() {}, subscriptions: () => new Uint8Array(), close() {}, pending: false, ended: false,
    pump(receive: (frame: unknown) => void) {
      if (Atomics.load(words, FRAMES) === read) return false;
      read++;
      const bytes = new Uint8Array(words.buffer, FRAME_DATA * 4, Atomics.load(words, FRAME_BYTES)).slice();
      receive(JSON.parse(new TextDecoder().decode(bytes)));
      return true;
    },
    waitReadable(ms: number) {
      if (Atomics.load(words, CHILD_STAGE) === 0) { Atomics.store(words, CHILD_STAGE, STAGE_WAITING); Atomics.notify(words, CHILD_STAGE); }
      Atomics.wait(words, FRAMES, read, ms);
    },
  };
}

export function groupRuntime(options: { group: Group; pid: number; env?: Record<string, string>; spawn?: (argv: string[], spawnOptions: { env: Record<string, string> }) => unknown; parentChannel?: object }): Threads {
  const process = { env: { ...options.env }, execArgv: [], execPath: "bun", cwd: () => "/", noDeprecation: false };
  const context = createContext({ EventTarget, Event, MessageEvent, DOMException, URL, Blob, structuredClone, SharedArrayBuffer, ArrayBuffer, Int32Array, Uint8Array, DataView, queueMicrotask, Atomics });
  const stream = () => Object.assign(new EventEmitter(), { pipe() {} });
  const modules: Record<string, unknown> = {
    process, path, events: EventEmitter, structured_clone: { structuredClone }, net: {},
    spawn: { spawn: options.spawn },
    worker_channel: { open: () => options.parentChannel ?? childChannel(options.group.words) },
    worker_stdio: { readable: () => ({ stream: stream(), drained: Promise.resolve() }), writable: () => null },
  };
  const internal: Record<string, unknown> = {
    native: Object.assign({ base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"), transferArrayBuffers() {} }, natives(options.group, options.pid)),
    realTimers: { setImmediate: (callback: () => void) => setImmediate(callback) }, messagePortRefs: 0, addIoWaiter() {},
    builtin: () => ({ createRequire: () => () => undefined }),
    require(name: string) {
      if (name in modules) return modules[name];
      if (name === "worker_codec" || name === "group_shared_objects") return runInContext(source(name), context)(internal);
      throw new Error(`Unexpected module ${name}`);
    },
  };
  return runInContext(source("worker_threads"), context)(internal);
}
