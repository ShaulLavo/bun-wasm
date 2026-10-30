// A shared-group QuickJS process's worker runtime (the real worker_threads, worker_codec,
// worker_channel, group_shared_objects and shared_lane sources) over a fake memory group held in
// SharedArrayBuffers, so processes on real threads see the pin ownership, bounded control pipes
// and FUTEX watches the host enforces (bunwasm-host `shm.rs`, `process/pipe.rs`). It is a Node
// control of the JavaScript protocol, not a qualification of the guest.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createContext, runInContext } from "node:vm";
import { Worker as Thread } from "node:worker_threads";

const repository = new URL("../../../", import.meta.url).pathname;
const sources = new Map<string, string>();
/** Runtime module source: `crates/bunwasm-runtime/src/js/<name>.ts`, or the generated shared_lane. */
function source(root: string, name: string) {
  const key = `${root}\0${name}`;
  let text = sources.get(key);
  if (text) return text;
  if (name === "shared_lane") {
    // The module bun.wasm embeds: scripts/generate-shared-lane.ts over this tree's lane.ts.
    const scratch = mkdtempSync(path.join(tmpdir(), "bun-wasm-shared-lane-"));
    try {
      const output = path.join(scratch, "shared_lane.js");
      const generated = Bun.spawnSync(["node", "--no-warnings", path.join(repository, "scripts/generate-shared-lane.ts"), path.join(root, "web/src/shared-objects/lane.ts"), output]);
      if (!generated.success) throw new Error(`generate-shared-lane failed: ${generated.stderr}`);
      text = `globalThis.factory = ${readFileSync(output, "utf8")}`;
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  } else {
    let input = readFileSync(path.join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), "utf8");
    if (name === "worker_threads") input = inspectRoutes(input);
    text = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${input}`);
  }
  sources.set(key, text);
  return text;
}

function inspectRoutes(input: string) {
  const target = "  internal.workerPump = pump;";
  if (input.split(target).length !== 2) throw new Error("Fixture route hook is no longer unique");
  return input.replace(target, `${target}\n  internal.workerRoutes = () => ({ owners: Array.from(owners.keys()), pending: Array.from(pending.keys()) });`);
}

/** Group words. CHILD_STAGE: 1 when pid 2 first tried to accept, 2 when it first blocked reading its pipe. */
export const CHILD_STAGE = 1, STAGE_WAITING = 2;
const STAGE_ACCEPT = 1, WAKE = 2, FAIL_ACCEPT = 4, WATCHES = 128, MEMBERS = 64, PINS = 16, PIN_SLOTS = 56;
const PIPES = 8, PIPE_HEADER = 4, READ = 0, WRITE = 1, WRITER_CLOSED = 2, READER_CLOSED = 3;
const AGAIN = -6, EBADF = 8, EPIPE = -64, FUTEX = 7, FIRST_FD = 100;
export const LANE_BYTES = 32 + 2 * 1024 * 1024;

/** One fake group: every member thread is given the same buffers (`share`) and rebuilds it (`attach`). */
export interface Group {
  readonly words: Int32Array;
  readonly pool: SharedArrayBuffer[];
  readonly used: Int32Array;
  readonly pipes: SharedArrayBuffer;
  readonly pipeCapacity: number;
}
export interface GroupBuffers { words: SharedArrayBuffer; pool: SharedArrayBuffer[]; used: SharedArrayBuffer; pipes: SharedArrayBuffer; pipeCapacity: number }

/** `regions` buffer sizes; a lane region per expected port pair. Pipes hold `pipeCapacity` bytes each (power of two). */
export function createGroup(regions: number[], pipeCapacity: number): Group {
  const pool = regions.map(bytes => new SharedArrayBuffer(bytes));
  return { words: new Int32Array(new SharedArrayBuffer(1024)), pool, used: new Int32Array(new SharedArrayBuffer(pool.length * 4)),
    pipes: new SharedArrayBuffer(PIPES * (PIPE_HEADER * 4 + pipeCapacity)), pipeCapacity };
}
export function share(group: Group): GroupBuffers {
  return { words: group.words.buffer as SharedArrayBuffer, pool: group.pool, used: group.used.buffer as SharedArrayBuffer, pipes: group.pipes, pipeCapacity: group.pipeCapacity };
}
export function attach(buffers: GroupBuffers): Group {
  return { words: new Int32Array(buffers.words), pool: buffers.pool, used: new Int32Array(buffers.used), pipes: buffers.pipes, pipeCapacity: buffers.pipeCapacity };
}
/** A region for pid's own use, as `new SharedArrayBuffer(bytes)` gives a group member. */
export function allocate(group: Group, bytes: number): SharedArrayBuffer {
  for (const [index, region] of group.pool.entries()) {
    if (region.byteLength === bytes && Atomics.compareExchange(group.used, index, 0, 1) === 0) return region;
  }
  throw new RangeError(`fake group has no free ${bytes}-byte region`);
}
/** Transit pins not yet accepted or unpinned, and FUTEX watches still registered. */
export function counters(group: Group) {
  let pins = 0;
  for (let slot = 0; slot < PIN_SLOTS; slot++) if (Atomics.load(group.words, PINS + slot * 2) !== 0) pins++;
  let watches = 0;
  for (let pid = 0; pid < MEMBERS; pid++) watches += Atomics.load(group.words, WATCHES + pid);
  return { pins, watches };
}
/** Member `pid`'s next shmAccept fails with EBADF, as a receipt of a pin it does not own would. */
export function failNextAccept(group: Group, pid: number) { Atomics.store(group.words, FAIL_ACCEPT, pid); }
/** A member exit, as the host settles it: its pins and watches are dropped. */
function releaseMember(group: Group, pid: number) {
  for (let slot = 0; slot < PIN_SLOTS; slot++) Atomics.compareExchange(group.words, PINS + slot * 2, pid, 0);
  Atomics.store(group.words, WATCHES + pid, 0);
}

function wake(group: Group) { Atomics.add(group.words, WAKE, 1); Atomics.notify(group.words, WAKE); }

/** Bounded byte pipes: fd FIRST_FD + 2 * pipe is the read end, + 1 the write end. */
function pipe(group: Group, fd: number) {
  const index = (fd - FIRST_FD) >> 1;
  if (index < 0 || index >= PIPES) throw new Error(`unknown fake pipe fd ${fd}`);
  const stride = PIPE_HEADER * 4 + group.pipeCapacity;
  return { header: new Int32Array(group.pipes, index * stride, PIPE_HEADER), bytes: new Uint8Array(group.pipes, index * stride + PIPE_HEADER * 4, group.pipeCapacity), writer: (fd - FIRST_FD) % 2 === 1 };
}
export function pipeFds(index: number) { return { read: FIRST_FD + index * 2, write: FIRST_FD + index * 2 + 1 }; }
/** Closes one end of a fake pipe, as a process exit does. */
export function closeFd(group: Group, fd: number) { pipeNatives(group).close(fd); }

function pipeNatives(group: Group) {
  const capacity = group.pipeCapacity;
  function write(fd: number, data: Uint8Array) {
    const { header, bytes } = pipe(group, fd);
    if (Atomics.load(header, READER_CLOSED)) return EPIPE;
    const used = (Atomics.load(header, WRITE) - Atomics.load(header, READ)) >>> 0;
    const count = Math.min(data.length, capacity - used);
    if (!count) return AGAIN;
    const start = Atomics.load(header, WRITE) >>> 0;
    for (let i = 0; i < count; i++) bytes[(start + i) % capacity] = data[i]!;
    Atomics.store(header, WRITE, (start + count) | 0); wake(group);
    return count;
  }
  function read(fd: number) {
    const { header, bytes } = pipe(group, fd);
    const start = Atomics.load(header, READ) >>> 0, available = (Atomics.load(header, WRITE) - start) >>> 0;
    if (!available) return Atomics.load(header, WRITER_CLOSED) ? 0 : AGAIN;
    const out = new Uint8Array(Math.min(available, 65536));
    for (let i = 0; i < out.length; i++) out[i] = bytes[(start + i) % capacity]!;
    Atomics.store(header, READ, (start + out.length) | 0); wake(group);
    return out;
  }
  function close(fd: number) {
    const { header, writer } = pipe(group, fd);
    Atomics.store(header, writer ? WRITER_CLOSED : READER_CLOSED, 1); wake(group);
    return 0;
  }
  function ready(fd: number, writable: boolean) {
    const { header } = pipe(group, fd);
    const used = (Atomics.load(header, WRITE) - Atomics.load(header, READ)) >>> 0;
    if (writable) return used < capacity || Atomics.load(header, READER_CLOSED) !== 0;
    return used > 0 || Atomics.load(header, WRITER_CLOSED) !== 0;
  }
  return { write, read, close, ready };
}

/** Group, pipe and poll natives of member `pid`, as the shared-group core and side give them. */
function natives(group: Group, pid: number) {
  const { words, pool } = group;
  const pipes = pipeNatives(group);
  const watches = new Map<number, { view: Int32Array; index: number; expected: number }>();
  let nextWatch = 1;
  const failure = (what: string) => new DOMException(`${what} failed in the memory group (errno ${EBADF})`, "DataCloneError");
  const pinOwner = (pin: number) => PINS + (pin - 1) * 2;
  function owned(pin: number) { return pin >= 1 && pin <= PIN_SLOTS && Atomics.load(words, pinOwner(pin)) === pid; }
  function readyEvents(subscriptions: Uint8Array) {
    const view = new DataView(subscriptions.buffer, subscriptions.byteOffset, subscriptions.byteLength);
    const events: Uint8Array[] = [];
    for (let offset = 0; offset < subscriptions.byteLength; offset += 16) {
      const kind = view.getUint32(offset, true), id = view.getUint32(offset + 4, true);
      let ready = false;
      if (kind === FUTEX) {
        const watch = watches.get(id);
        if (!watch) return -EBADF;
        ready = Atomics.load(watch.view, watch.index) !== watch.expected;
      } else if (kind === 0 || kind === 1) ready = pipes.ready(id, kind === 1);
      else return -28;
      if (!ready) continue;
      const event = new Uint8Array(16), out = new DataView(event.buffer);
      event.set(subscriptions.subarray(offset + 8, offset + 16));
      out.setUint32(8, kind, true);
      events.push(event);
    }
    return events;
  }
  return {
    procGetpid: () => pid,
    procWrite: pipes.write, procRead: pipes.read, procClose: pipes.close,
    procPoll(subscriptions: Uint8Array, timeout: number) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const seen = Atomics.load(words, WAKE);
        const events = readyEvents(subscriptions);
        if (typeof events === "number") return events;
        if (events.length || Date.now() >= deadline) return Buffer.concat(events);
        if (pid === 2 && Atomics.load(words, CHILD_STAGE) === 0) { Atomics.store(words, CHILD_STAGE, STAGE_WAITING); Atomics.notify(words, CHILD_STAGE); }
        Atomics.wait(words, WAKE, seen, Math.min(1, deadline - Date.now()));
      }
    },
    shmPin(buffer: SharedArrayBuffer) {
      const region = pool.indexOf(buffer);
      if (region < 0) throw new Error("not a fake group region");
      for (let pin = 1; pin <= PIN_SLOTS; pin++) {
        if (Atomics.compareExchange(words, pinOwner(pin), 0, pid) !== 0) continue;
        Atomics.store(words, pinOwner(pin) + 1, region);
        return pin;
      }
      throw failure("SharedArrayBuffer publication");
    },
    shmRoute(pin: number, to: number) {
      if (!owned(pin) || Atomics.compareExchange(words, pinOwner(pin), pid, to) !== pid) throw failure("SharedArrayBuffer routing");
      return 0;
    },
    shmUnpin(pin: number) {
      if (!owned(pin)) throw failure("SharedArrayBuffer unpin");
      Atomics.store(words, pinOwner(pin), 0);
      return 0;
    },
    shmAccept(pin: number) {
      if (pid === 2 && Atomics.load(words, CHILD_STAGE) === 0) { Atomics.store(words, CHILD_STAGE, STAGE_ACCEPT); Atomics.notify(words, CHILD_STAGE); }
      if (!owned(pin) || Atomics.compareExchange(words, FAIL_ACCEPT, pid, 0) === pid) throw failure("SharedArrayBuffer receipt");
      const region = Atomics.load(words, pinOwner(pin) + 1);
      Atomics.store(words, pinOwner(pin), 0);
      return pool[region];
    },
    futexWatch(buffer: SharedArrayBuffer, byteOffset: number, expected: number) {
      const id = nextWatch++;
      watches.set(id, { view: new Int32Array(buffer), index: byteOffset / 4, expected });
      Atomics.add(words, WATCHES + pid, 1);
      return id;
    },
    futexUnwatch(id: number) {
      if (!watches.delete(id)) throw failure("Shared lane unwatch");
      Atomics.sub(words, WATCHES + pid, 1);
      return 0;
    },
  };
}

interface Threads {
  readonly workerData: unknown;
  readonly parentPort: (EventEmitter & { postMessage(value: unknown, transfer?: unknown[]): void; close(): void }) | null;
  initialize(): void;
  receiveMessageOnPort(port: unknown): { message: unknown } | undefined;
  MessageChannel: new () => { port1: EventEmitter & { postMessage(value: unknown, transfer?: unknown[]): void; close(): void }; port2: EventEmitter & { postMessage(value: unknown, transfer?: unknown[]): void; close(): void } };
  Worker: new (filename: string, options: object) => EventEmitter & { postMessage(value: unknown, transfer?: unknown[]): void; terminate(): Promise<number> };
}
export interface Member { threads: Threads; loop: { stop(): void }; release(): void; routes(): { owners: string[]; pending: string[] } }
export interface ChildSpec { pid: number; fds: { input: number; output: number }; env: Record<string, string> }

/**
 * Member `pid`'s runtime. `spawn` starts a child (on a thread) with `ChildSpec`; `sources` is a
 * repository root to read the runtime from (the current tree by default, or an older commit's).
 */
export function groupRuntime(options: { group: Group; pid: number; env?: Record<string, string>; sources?: string;
  spawn?: (spec: ChildSpec) => { exited: Promise<number>; kill(): void } }): Member {
  const root = options.sources ?? repository;
  const group = options.group;
  const process = { env: { ...options.env }, execArgv: [], execPath: "bun", cwd: () => "/", noDeprecation: false, pid: 1 };
  const GroupSharedArrayBuffer = function SharedArrayBuffer(bytes: number) { return allocate(group, bytes); } as unknown as SharedArrayBufferConstructor;
  Object.defineProperty(GroupSharedArrayBuffer, "prototype", { value: SharedArrayBuffer.prototype });
  const context = createContext({ EventTarget, Event, MessageEvent, DOMException, URL, Blob, structuredClone, TextEncoder, TextDecoder, Object, JSON,
    SharedArrayBuffer: GroupSharedArrayBuffer, ArrayBuffer, Int32Array, Uint8Array, DataView, queueMicrotask, Atomics });
  const native = natives(group, options.pid);
  const waiters = new Set<{ ref?: boolean; step(): unknown; subscriptions?(): Uint8Array }>();
  let nextPipe = options.pid * 2, nextPid = options.pid;
  const stream = () => Object.assign(new EventEmitter(), { pipe() {} });
  const modules: Record<string, unknown> = {
    process, path, events: EventEmitter, structured_clone: { structuredClone }, net: {},
    spawn: { spawn(_argv: string[], spawnOptions: { env: Record<string, string> }) {
      const toChild = pipeFds(nextPipe++), toParent = pipeFds(nextPipe++);
      const pid = ++nextPid;
      const fds = { input: toChild.read, output: toParent.write };
      const child = options.spawn!({ pid, fds, env: { ...spawnOptions.env, BUNWASM_WORKER_CONTROL: JSON.stringify(fds) } });
      const exited = child.exited;
      return { pid, _workerChannel: { input: toParent.read, output: toChild.write }, stdout: null, stderr: null, stdin: null,
        exited, signalCode: null, ref() {}, unref() {}, kill() { child.kill(); return true; }, _abortWorker() { child.kill(); }, _finishWorker() {} };
    } },
    worker_stdio: { readable: () => ({ stream: stream(), drained: Promise.resolve() }), writable: () => null },
  };
  const concatBytes = (parts: Uint8Array[]) => Buffer.concat(parts);
  const internal: Record<string, unknown> = {
    native: Object.assign({ base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"), base64Decode: (text: string) => new Uint8Array(Buffer.from(text, "base64")),
      transferArrayBuffers() {}, utf8Decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes) }, native),
    realTimers: { setImmediate: (callback: () => void) => setImmediate(callback) }, messagePortRefs: 0, concatBytes,
    addIoWaiter(waiter: { ref?: boolean; step(): unknown }) { waiters.add(waiter); return waiter; },
    builtin: () => ({ createRequire: () => () => undefined }),
    require(name: string) {
      if (name in modules) return modules[name];
      if (["worker_codec", "group_shared_objects", "worker_channel", "shared_lane"].includes(name)) {
        runInContext(source(root, name), context);
        const factory = (context as { factory: (internal: unknown) => unknown }).factory;
        return modules[name] = factory(internal);
      }
      throw new Error(`Unexpected module ${name}`);
    },
  };
  runInContext(source(root, "worker_threads"), context);
  const threads = (context as { factory: (internal: unknown) => Threads }).factory(internal);
  // The guest event loop's I/O half: step every waiter, then sleep on the referenced ones' subscriptions.
  let running = true;
  function turn() {
    if (!running) return;
    let progress = Boolean((internal.workerPump as (() => boolean) | undefined)?.());
    for (const waiter of waiters) progress = Boolean(waiter.step()) || progress;
    const watched = Array.from(waiters, waiter => waiter.ref === false ? new Uint8Array() : waiter.subscriptions?.() ?? new Uint8Array());
    if (!progress) native.procPoll(concatBytes(watched), 2);
    setImmediate(turn);
  }
  setImmediate(turn);
  const routes = () => (internal.workerRoutes as () => { owners: string[]; pending: string[] })();
  return { threads, loop: { stop() { running = false; } }, release() { running = false; releaseMember(group, options.pid); }, routes };
}

/**
 * Starts `script` (a child member module) on a thread with the group buffers and its spec. When the
 * thread is gone the "host" settles it: its control pipe ends close and its pins and watches drop.
 */
export function startChild(script: URL, group: Group, spec: ChildSpec, extra: Record<string, unknown> = {}) {
  const thread = new Thread(script, { workerData: { group: share(group), spec, ...extra } });
  const exited = new Promise<number>(resolve => thread.once("exit", code => {
    closeFd(group, spec.fds.input); closeFd(group, spec.fds.output); releaseMember(group, spec.pid);
    resolve(code);
  }));
  return { thread, exited, kill() { void thread.terminate(); } };
}
