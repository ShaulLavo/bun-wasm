import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import * as nodePath from "node:path";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import * as nodeStream from "node:stream";

// spawn.ts against an in-memory runtime_proc service: descriptors, pipes with reference counts,
// typed wait and job reaping. Real hosts are covered by the browser, Node and native ABI suites.
const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.spawnFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/spawn.ts", import.meta.url), "utf8")}`);

const EAGAIN = -6;

interface FakePipe { chunks: Uint8Array[]; queuedBytes: number; readers: number; writers: number; capacity: number }
// Canonical runtime_proc.wait results, not shell-style 128 + signal exit statuses.
export type ProcessExit = [kind: 0, code: number] | [kind: 1, signal: number] | [kind: 2, wasiErrno: number];
interface FakeChild {
  pid: number; job: number; request: Record<string, any>;
  started: boolean; selected: ProcessExit | null; status: ProcessExit | null;
  held: Map<number, { pipe: FakePipe; write: boolean }>; reaped: boolean; waited?: boolean; liveDescendants: number;
}
interface ServiceOptions {
  failSpawn?: number;
  deferStart?: boolean;
  now?: () => number;
  onSpawn?(child: FakeChild): void;
  onPoll?(turn: number): void;
  pipeCapacity?: number;
}

export function service(options: ServiceOptions = {}) {
  const pipes = new Map<number, { pipe: FakePipe; write: boolean }>();
  const children = new Map<number, FakeChild>();
  const calls: string[] = [];
  let next = 5;
  let pid = 100;
  let polls = 0;
  const release = (entry: { pipe: FakePipe; write: boolean }) => { if (entry.write) entry.pipe.writers--; else entry.pipe.readers--; };
  const retain = (entry: { pipe: FakePipe; write: boolean }) => { if (entry.write) entry.pipe.writers++; else entry.pipe.readers++; };
  const select = (child: FakeChild, outcome: ProcessExit) => { child.selected ??= outcome; };
  // Selection wins races immediately; publication follows guest teardown and releases its pipes.
  const publish = (child: FakeChild) => {
    if (child.status) return;
    if (!child.selected) throw new Error("cannot publish an unselected process outcome");
    child.status = child.selected;
    for (const entry of child.held.values()) release(entry);
    child.held.clear();
  };
  const stop = (child: FakeChild, outcome: ProcessExit) => {
    if (child.selected) return;
    select(child, outcome);
    publish(child);
  };
  const native: Record<string, any> = {
    hostCaps: { proc_spawn: true }, cwd: () => "/work", now: options.now ?? (() => Date.now()),
    stat(path: string) {
      if (["/", "/work", "/tmp"].includes(path)) return { mode: 0o040755 };
      if (path === "/work/file.txt") return { mode: 0o100644 };
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT", errno: -2, syscall: "stat" });
    },
    procAccess() { return 0; },
    procPipe() {
      const pipe: FakePipe = { chunks: [], queuedBytes: 0, readers: 1, writers: 1, capacity: options.pipeCapacity ?? Number.POSITIVE_INFINITY };
      const ends = [next++, next++] as [number, number];
      pipes.set(ends[0], { pipe, write: false });
      pipes.set(ends[1], { pipe, write: true });
      return ends;
    },
    procClose(fd: number) {
      const entry = pipes.get(fd);
      if (!entry) return -8;
      pipes.delete(fd);
      release(entry);
      return 0;
    },
    procSpawn(json: string) {
      calls.push("spawn");
      if (options.failSpawn) return options.failSpawn;
      const request = JSON.parse(json);
      const child: FakeChild = { pid: pid++, job: 7 + children.size, request, started: false, selected: null, status: null, held: new Map(), reaped: false, liveDescendants: 0 };
      for (const { child: number, parent } of request.fds) {
        const entry = pipes.get(parent);
        if (!entry) continue; // inherited stdio: not a pipe
        retain(entry);
        child.held.set(number, entry);
      }
      children.set(child.pid, child);
      options.onSpawn?.(child);
      if (!options.deferStart && (!child.selected || child.selected[0] === 0)) child.started = true;
      return child.pid;
    },
    ownJob: 3,
    procJobOf(id: number) { return id === 0 ? this.ownJob : children.get(id)?.job ?? -71; },
    procRead(fd: number) {
      const entry = pipes.get(fd);
      if (!entry) return -8;
      const chunk = entry.pipe.chunks.shift();
      if (chunk) {
        entry.pipe.queuedBytes -= chunk.length;
        return chunk;
      }
      return entry.pipe.writers === 0 ? 0 : EAGAIN;
    },
    procWrite(fd: number, bytes: Uint8Array) {
      const entry = pipes.get(fd);
      if (!entry) return -8;
      if (entry.pipe.readers === 0) return -64;
      const available = entry.pipe.capacity - entry.pipe.queuedBytes;
      if (available <= 0) return EAGAIN;
      const count = Math.min(available, bytes.length);
      entry.pipe.chunks.push(bytes.slice(0, count));
      entry.pipe.queuedBytes += count;
      return count;
    },
    procStartStatus(id: number) {
      const child = children.get(id);
      if (!child || child.reaped || child.waited) return -12;
      if (child.started) return 0;
      return child.selected ? child.selected[0] === 2 ? child.selected[1] : -11 : EAGAIN;
    },
    procWait(id: number) {
      const child = children.get(id);
      if (!child || child.reaped || child.waited) return -12;
      if (!child.status) return EAGAIN;
      child.waited = true;
      return child.status;
    },
    procWaitJob(job: number) {
      const child = Array.from(children.values()).find((candidate) => candidate.job === job);
      if (!child || child.reaped) return -12;
      if (!child.status || child.liveDescendants > 0) return EAGAIN;
      child.reaped = true;
      calls.push("reap");
      return child.status;
    },
    procKill(id: number, signal: number) {
      calls.push(`kill:${signal}`);
      const child = children.get(id);
      if (!child) return -71;
      stop(child, [1, signal]);
      return 0;
    },
    procKillJob(job: number, signal: number) {
      calls.push(`killJob:${signal}`);
      const child = Array.from(children.values()).find((candidate) => candidate.job === job);
      if (!child) return -71;
      stop(child, [1, signal]);
      return 0;
    },
    procPoll(subscriptions: Uint8Array) {
      calls.push(`poll:${subscriptions.length / 16}`);
      options.onPoll?.(++polls);
      return new Uint8Array(0);
    },
  };
  return {
    native, calls, children, pipes, select, publish,
    exit(child: FakeChild, code: number) { select(child, [0, code]); publish(child); },
    childClose(child: FakeChild, fd: number) {
      const entry = child.held.get(fd)!;
      child.held.delete(fd);
      release(entry);
    },
    /** What a child process would write to its descriptor. */
    childWrite(child: FakeChild, fd: number, text: string) {
      const entry = child.held.get(fd)!;
      const chunk = new TextEncoder().encode(text);
      entry.pipe.chunks.push(chunk);
      entry.pipe.queuedBytes += chunk.length;
    },
    childWriteBytes(child: FakeChild, fd: number, chunk: Uint8Array) {
      const entry = child.held.get(fd)!;
      const copy = chunk.slice();
      entry.pipe.chunks.push(copy);
      entry.pipe.queuedBytes += copy.length;
    },
    childRead(child: FakeChild, fd: number) {
      const entry = child.held.get(fd)!;
      const chunk = entry.pipe.chunks.shift();
      if (chunk) {
        entry.pipe.queuedBytes -= chunk.length;
        return new TextDecoder().decode(chunk);
      }
      return entry.pipe.writers === 0 ? null : "";
    },
    open: () => pipes.size,
  };
}

interface TestTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate: typeof setImmediate;
}

export function load(fake: ReturnType<typeof service>, options: { execArgv?: string[]; timers?: TestTimers; spawnArguments?: (argv: string[], cwd: unknown) => string[] } = {}) {
  const waiters: any[] = [];
  const process = Object.assign(new EventEmitter(), { env: { HOME: "/home", PATH: "/bin:/usr/bin" }, execArgv: options.execArgv ?? [], execPath: "bun", exitCode: 0, cwd: () => "/work" });
  const factory = runInNewContext(source, {
    ReadableStream, Response, URL, TextEncoder, TextDecoder, Promise, process,
  });
  const modules: Record<string, unknown> = { buffer: { Buffer }, path: nodePath, net: {}, events: EventEmitter, process, package_scripts: { spawnArguments: options.spawnArguments ?? ((argv: string[]) => argv) } };
  const internal = {
    native: fake.native,
    web: { ReadableStream, Response },
    realTimers: options.timers ?? { setTimeout, clearTimeout, setImmediate },
    toUint8: (value: ArrayBufferView) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    concatBytes: (chunks: Uint8Array[]) => Buffer.concat(chunks),
    nextTick: (callback: () => void) => queueMicrotask(callback),
    builtin: (name: string) => name === "node:stream" ? nodeStream : (() => { throw new Error(`Unexpected builtin ${name}`); })(),
    addIoWaiter(waiter: any) { waiters.push(waiter); return waiter; },
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
      return modules[name];
    },
  };
  modules.child_ipc = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.ipcFactory = ${readFileSync(
    new URL("../crates/bunwasm-runtime/src/js/child_ipc.ts", import.meta.url), "utf8")}`), { TextEncoder, TextDecoder })(internal);
  const module = factory(internal);
  /** Match pumpIo: remove a throwing waiter before handing the error to its fail handler. */
  const pumpTurn = () => {
    for (const waiter of waiters.slice()) {
      try {
        if (waiter.step() === true) waiters.splice(waiters.indexOf(waiter), 1);
      } catch (error) {
        waiters.splice(waiters.indexOf(waiter), 1);
        if (waiter.fail) waiter.fail(error);
        else throw error;
      }
    }
  };
  /** Runs every waiter's step until it finishes, like the event loop's pumpIo. */
  const pump = async (limit = 50) => {
    for (let turn = 0; turn < limit; turn++) {
      pumpTurn();
      await Promise.resolve();
      if (!waiters.some((waiter) => waiter.ref || waiter.subscriptions?.().length)) return;
    }
    throw new Error("waiters did not finish");
  };
  return { module, process, internal, waiters, pump, pumpTurn, ipc: modules.child_ipc as { open(target: EventEmitter, descriptors: { input: number; output: number }, childSide?: boolean): { connected: boolean; send(message: unknown, handle?: unknown, options?: unknown, callback?: unknown): boolean; disconnect(): void; close(): void; ref(): unknown; unref(): unknown } } };
}

export function loadExit(fake: ReturnType<typeof service>, options: { workerError?: (error: unknown) => void; workerExit?: (code: number) => void } = {}) {
  const loaded = load(fake);
  const errors: unknown[] = [];
  const cleanup: string[] = [];
  const bootstrap = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const source = bootstrap.slice(bootstrap.indexOf("  function emitExit(code)"), bootstrap.indexOf("  internal.emitExit = emitExit;"));
  Object.assign(loaded.internal, options, { cancelIoWaiters() { cleanup.push("cancelIoWaiters"); } });
  const emitExit: (code: number) => void = runInNewContext(`${source}; emitExit`, {
    process: loaded.process, internal: loaded.internal,
    native: { tlsDispose() {}, closeAllDirs() { cleanup.push("closeAllDirs"); } },
    printError(error: unknown) { errors.push(error); },
  });
  return { ...loaded, emitExit, errors, cleanup };
}
