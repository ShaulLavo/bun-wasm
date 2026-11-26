import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resourceFrames } from "./resource-frame-source";
import { GuestWatchTable } from "../web/node_modules/waffle/fs/guest-watch.ts";
import { MemoryBackend } from "../web/node_modules/waffle/fs/backend.ts";
import { WatchService } from "../web/node_modules/waffle/fs/watch-service.ts";
import { FilesystemError } from "../web/node_modules/waffle/core/filesystem.ts";
import type { WatchBatch } from "../web/node_modules/waffle/fs/watch.ts";

// The shipped watcher and the real net.js waiter scheduler over the frozen runtime_fs watch ABI
// as the natives surface it: fsWatchOpen returns an id, fsWatchRead returns whole padded
// records, 0 at the end or -errno. Everything is per-fixture memory; nothing needs teardown.
interface Watcher extends EventEmitter {
  close(): Watcher;
  ref(): Watcher;
  unref(): Watcher;
}
type Listener = (...args: any[]) => void;
interface WatchModule {
  watch(path: string, listener: Listener): Watcher;
  watch(path: string, options?: unknown, listener?: Listener): Watcher;
}

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpile = (name: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${readFileSync(new URL(name, directory), "utf8")}`);

const encoder = new TextEncoder();
function record(type: "change" | "rename" | "overflow", name?: string | null) {
  const bytes = name == null ? new Uint8Array(0) : encoder.encode(name);
  const out = new Uint8Array(8 + ((bytes.length + 3) & ~3));
  out[0] = { change: 1, rename: 2, overflow: 3 }[type];
  new DataView(out.buffer).setUint32(4, name == null ? 0xffffffff : bytes.length, true);
  out.set(bytes, 8);
  return out;
}
const chunk = (...records: Uint8Array[]) => Buffer.concat(records);

/** runtime_fs.watch_next over a real GuestWatchTable, as natives.rs surfaces it. */
function tableNext(table: GuestWatchTable): () => [number, Uint8Array | number] | number {
  return () => {
    try {
      const result = table.readNext(65536);
      if (result.kind === "error") return -result.errno;
      if (result.kind === "watch_error") return [result.id, -result.errno];
      if (result.kind === "short") throw new Error("unexpected short watch record");
      return [result.id, result.length ? Buffer.concat(result.records) : 0];
    } catch (error) {
      if (error instanceof FilesystemError) return -error.errno;
      throw error;
    }
  };
}

function fixture(options: { resolve?: (path: string) => { dev?: bigint; ino: bigint } | number } = {}) {
  const queued = new Map<number, (Uint8Array | number)[]>();
  const opened: { path: string; recursive: boolean; id: number; fd?: number }[] = [];
  const closed: number[] = [];
  const droppedFds: number[] = [];
  const fdToPath = new Map<number, string>();
  const ticks: (() => void)[] = [];
  const effects = { stats: 0, timers: 0, scans: 0 };
  const traffic = { readiness: 0, reads: 0, next: 0 };
  let nextId = 40;
  let nextFd = 100;
  let openResult: number | undefined;
  let net: unknown;
  const internal: any = {
    native: {
      hostCaps: {},
      fsWatchResolve(path: string): [number, string] | number {
        const fd = nextFd++;
        fdToPath.set(fd, path);
        if (!options.resolve) return [fd, ""];
        const resolved = options.resolve(path);
        if (typeof resolved === "number") {
          fdToPath.delete(fd);
          return resolved;
        }
        const identity = resolved.ino === 0n ? "" : `${resolved.dev ?? 0n}:${resolved.ino}`;
        return [fd, identity];
      },
      fsWatchOpenFd(fd: number, recursive: boolean) {
        if (openResult !== undefined) return openResult;
        const id = nextId++;
        opened.push({ path: fdToPath.get(fd) ?? "", recursive, id, fd });
        queued.set(id, []);
        return id;
      },
      fsWatchDropFd(fd: number) {
        droppedFds.push(fd);
        fdToPath.delete(fd);
      },
      fsWatchReady() {
        traffic.readiness++;
        return Array.from(queued.values()).some(records => records.length > 0);
      },
      fsWatchRead(id: number) {
        traffic.reads++;
        if (closed.includes(id)) return -8;
        return queued.get(id)?.shift() ?? -6;
      },
      // Like runtime_fs.watch_next: the first open watch with a result, then rotate it last.
      fsWatchNext(): [number, Uint8Array | number] | number {
        traffic.next++;
        for (const [id, results] of queued) {
          if (closed.includes(id) || results.length === 0) continue;
          queued.delete(id);
          queued.set(id, results);
          return [id, results.shift()!];
        }
        return -6;
      },
      fsWatchClose(id: number) {
        if (closed.includes(id)) return -8;
        closed.push(id);
        return 0;
      },
      procPoll() { throw new Error("a watch must not sleep in runtime_proc.poll"); },
    },
    nextTick: (callback: () => void) => ticks.push(callback),
    timers: { setInterval() { effects.timers++; return { ref() {}, unref() {} }; }, clearInterval() {} },
    concatBytes: (parts: Uint8Array[]) => Buffer.concat(parts),
    web: { Request, Response, Headers },
    require(name: string): unknown {
      if (name === "events") return EventEmitter;
      if (name === "buffer") return { Buffer };
      if (name === "http_common") return {};
      if (name === "websocket") return { clientClass: () => class {} };
      if (name === "resource_frame") return resourceFrames();
      if (name === "io_pump") return runInNewContext(transpile("io_pump.ts"))(internal);
      if (name === "net") return net ??= runInNewContext(readFileSync(new URL("net.js", directory), "utf8"), { Uint8Array, ArrayBuffer, DataView, URL, TextEncoder })(internal);
      throw new Error(`Unexpected module ${name}`);
    },
  };
  internal.require("net");
  const filesystem = {
    statSync() { effects.stats++; return { ino: 1, size: 0, mtimeMs: 0, ctimeMs: 0, isDirectory: () => true, isSymbolicLink: () => false }; },
    lstatSync() { effects.scans++; throw Object.assign(new Error("scan"), { code: "ENOENT" }); },
    readdirSync() { effects.scans++; return []; },
    toPath: (path: string) => path,
    absolute: (path: string) => path,
  };
  const factory = runInNewContext(transpile("fs_watch.ts"), { AbortSignal });
  const module: WatchModule = factory(internal)(filesystem);
  return {
    module, opened, closed, droppedFds, effects, traffic, internal,
    commit(id: number, ...results: (Uint8Array | number)[]) { queued.get(id)!.push(...results); },
    failOpen(errno: number) { openResult = -errno; },
    pump: (): boolean => internal.pumpIo(),
    pending: (): number => internal.ioPending(),
    runTicks() { while (ticks.length) ticks.shift()!(); },
  };
}

test("idle turns query readiness once and read none of the registered watches", () => {
  const world = fixture();
  const watchers = Array.from({ length: 2000 }, (_, index) => world.module.watch(`/app/${index}`));
  try {
    for (let turn = 0; turn < 10; turn++) expect(world.pump()).toBe(false);
    expect(world.traffic).toEqual({ readiness: 10, reads: 0, next: 0 });
  } finally { for (const watcher of watchers) watcher.close(); }
  world.pump();
  expect(world.traffic.readiness).toBe(10);
});

function providerFixture() {
  const world = fixture();
  const cells = new Int32Array(new SharedArrayBuffer(16));
  let revoked = false, closed = 0, id = 0, failed = false;
  let batch: WatchBatch = { kind: "events", events: [] };
  const table = new GuestWatchTable({ cells, get revoked() { return revoked; }, open: () => 1,
    read() { if (failed) throw new FilesystemError(29); return batch; }, close() { closed++; } });
  world.internal.native.fsWatchResolve = () => [1, ""];
  world.internal.native.fsWatchOpenFd = (fd: number, recursive: boolean) => id = table.open(fd, recursive);
  world.internal.native.fsWatchDropFd = () => {};
  world.internal.native.fsWatchReady = () => table.ready();
  world.internal.native.fsWatchRead = (watch: number) => {
    try {
      const result = table.read(watch, 65536);
      if (result.kind === "error") return -result.errno;
      if (result.kind === "short") throw new Error("unexpected short watch record");
      return result.length ? Buffer.concat(result.records) : 0;
    } catch (error) {
      if (error instanceof FilesystemError) return -error.errno;
      throw error;
    }
  };
  world.internal.native.fsWatchNext = tableNext(table);
  world.internal.native.fsWatchClose = (watch: number) => table.close(watch);
  return { ...world, table, id: () => id, closed: () => closed,
    commit(value: WatchBatch) { batch = value; Atomics.add(cells, 3, 1); },
    revoke() { revoked = true; }, fail() { failed = true; Atomics.add(cells, 3, 1); } };
}

test("provider ended readiness closes the consumer even when scheduling pending is false", () => {
  const world = providerFixture();
  const watcher = world.module.watch("/app");
  world.commit({ kind: "closed", events: [] });
  expect(world.table.read(world.id(), 65536)).toMatchObject({ kind: "records", length: 0 });
  expect(world.table.pending()).toBe(false);
  expect(world.table.ready()).toBe(true);
  expect(world.pump()).toBe(true);
  expect(world.pending()).toBe(0);
  expect(world.closed()).toBe(1);
  expect(world.table.ready()).toBe(false);
  watcher.close();
});

test("provider queued readiness delivers a record without another generation change", () => {
  const world = providerFixture();
  const seen: string[] = [];
  const watcher = world.module.watch("/app", (_event, name) => seen.push(String(name)));
  try {
    world.commit({ kind: "events", events: [{ type: "change", id: 1n, name: "page.ts" }] });
    expect(world.table.read(world.id(), 0).kind).toBe("short");
    expect(world.pump()).toBe(true);
    expect(seen).toEqual(["page.ts"]);
    expect(world.table.ready()).toBe(false);
  } finally { watcher.close(); }
});

test.each([false, true])("provider error readiness retires the consumer, revoked=%s", revoked => {
  const world = providerFixture();
  const errors: string[] = [];
  const watcher = world.module.watch("/app");
  watcher.on("error", (error: { code: string }) => errors.push(error.code));
  if (revoked) world.revoke(); else world.fail();
  expect(world.table.ready()).toBe(true);
  expect(world.pump()).toBe(true);
  expect(errors).toEqual([revoked ? "ECANCELED" : "EIO"]);
  expect(world.pending()).toBe(0);
  expect(world.table.ready()).toBe(false);
});

test("a nested idle pump cannot change its outer turn's readiness", () => {
  const world = fixture();
  const events: string[] = [];
  const first = world.module.watch("/first", () => {
    expect(world.pump()).toBe(false);
    world.commit(41, record("change", "second"));
    events.push("first");
  });
  const second = world.module.watch("/second", () => events.push("second"));
  try {
    world.commit(40, record("change", "first"));
    expect(world.pump()).toBe(true);
    expect(events).toEqual(["first", "second"]);
    expect(world.traffic.readiness).toBe(2);
  } finally { first.close(); second.close(); }
});

test("a write committed before the pump reaches change listeners before a socket step runs its handler, with no timer", () => {
  const world = fixture();
  const log: string[] = [];
  // The reload's socket was accepted before the watch, so registration order alone would step it first.
  let reload = true;
  world.internal.addIoWaiter({ step() { if (!reload) return false; reload = false; log.push("request"); return "progress"; } });
  const watcher = world.module.watch("/app", { recursive: true }, (event, name) => log.push(`${event} ${name}`));
  world.commit(world.opened[0]!.id, chunk(record("change", "page.tsx")));
  world.pump();
  expect(log).toEqual(["change page.tsx", "request"]);
  expect(world.effects).toEqual({ stats: 0, timers: 0, scans: 0 });
  expect(world.opened).toEqual([{ path: "/app", recursive: true, id: 40, fd: 100 }]);
  expect(world.droppedFds).toEqual([100]);
  watcher.close();
});

test("a write committed while the pump runs is not claimed for that pump; the next drain delivers it", () => {
  const world = fixture();
  const log: string[] = [];
  world.module.watch("/app", (event, name) => log.push(`${event} ${name}`));
  let reload = true;
  world.internal.addIoWaiter({ step() {
    if (!reload) return false;
    reload = false;
    world.commit(40, chunk(record("change", "late.tsx")));
    log.push("request");
    return "progress";
  } });
  world.pump();
  expect(log).toEqual(["request"]);
  world.pump();
  expect(log).toEqual(["request", "change late.tsx"]);
});

test("watch waiters expose no runtime_proc subscriptions, so the loop sleeps in the network host poll", () => {
  const world = fixture();
  world.module.watch("/dir");
  expect(world.internal.ioWait(25)).toBe(false);
});

test("one step drains every queued record until EAGAIN", () => {
  const world = fixture();
  const events: unknown[][] = [];
  world.module.watch("/dir", (...args) => events.push(args));
  const id = world.opened[0]!.id;
  world.commit(id, chunk(record("rename", "a"), record("change", "sub/b")), chunk(record("change", "a")));
  expect(world.pump()).toBe(true);
  expect(events).toEqual([["rename", "a"], ["change", "sub/b"], ["change", "a"]]);
  expect(world.pump()).toBe(false);
});

test("filenames honor the validated encoding, and the root reports its basename", () => {
  const world = fixture();
  const seen: unknown[] = [];
  world.module.watch("/w/file.txt", "buffer", (_, name) => seen.push(name));
  world.module.watch("/w/dir", { encoding: "hex" }, (_, name) => seen.push(name));
  world.module.watch("/w/x", (_, name) => seen.push(name));
  world.commit(40, chunk(record("change", null)));
  world.commit(41, chunk(record("rename", "é")));
  world.commit(42, chunk(record("change", "ü/ß")));
  world.pump();
  expect(Buffer.isBuffer(seen[0]) && (seen[0] as Buffer).toString()).toBe("file.txt");
  expect(seen.slice(1)).toEqual([Buffer.from("é").toString("hex"), "ü/ß"]);
});

test.each([[44, "ENOENT", -2], [6, "ENOSPC", -28], [2, "EACCES", -13], [58, "ENOTSUP", -95]] as const)("registration errno %d throws %s and leaves nothing registered", (errno, code, nodeErrno) => {
  const world = fixture();
  world.failOpen(errno);
  expect(() => world.module.watch("/gone")).toThrow(expect.objectContaining({ code, errno: nodeErrno, syscall: "watch", path: "/gone" }));
  expect(world.pending()).toBe(0);
});

test("persistent, ref and unref decide whether the watch keeps the loop alive", () => {
  const world = fixture();
  const quiet = world.module.watch("/a", { persistent: false });
  expect(world.pending()).toBe(0);
  quiet.ref();
  expect(world.pending()).toBe(1);
  quiet.unref();
  expect(world.pending()).toBe(0);
  quiet.close();
  quiet.ref();
  expect(world.pending()).toBe(0);
});

test("close is idempotent, releases the watch id and emits close once on a later tick", () => {
  const world = fixture();
  const watcher = world.module.watch("/a", () => { throw new Error("closed watcher emitted"); });
  let closes = 0;
  watcher.on("close", () => closes++);
  world.commit(40, chunk(record("change", "x")));
  watcher.close();
  watcher.close();
  expect(closes).toBe(0);
  world.runTicks();
  expect([closes, world.closed, world.pending()]).toEqual([1, [40], 0]);
  world.pump();
});

test("abort signals close before or after registration and detach their listener", () => {
  const world = fixture();
  const early = new AbortController();
  early.abort();
  const late = new AbortController();
  const order: string[] = [];
  world.module.watch("/a", { signal: early.signal }).on("close", () => order.push("early"));
  world.module.watch("/b", { signal: late.signal }).on("close", () => order.push("late"));
  late.abort();
  world.runTicks();
  world.runTicks();
  expect([order, world.closed]).toEqual([["late", "early"], [41, 40]]);
});

test("end of stream closes quietly; read errors and overflow emit error then close", () => {
  const world = fixture();
  const outcomes: string[] = [];
  const track = (name: string, watcher: Watcher) => watcher
    .on("change", (event, file) => outcomes.push(`${name} ${event} ${file}`))
    .on("error", (error: { code: string; syscall: string }) => outcomes.push(`${name} error ${error.code} ${error.syscall}`))
    .on("close", () => outcomes.push(`${name} close`));
  track("ended", world.module.watch("/a"));
  track("failed", world.module.watch("/b"));
  track("overflowed", world.module.watch("/c"));
  track("revoked", world.module.watch("/d"));
  world.commit(40, 0);
  world.commit(41, -29);
  world.commit(42, chunk(record("change", "kept"), record("overflow")), 0);
  world.commit(43, -11);
  world.pump();
  world.runTicks();
  expect(outcomes).toEqual([
    "failed error EIO watch",
    "overflowed change kept",
    "overflowed error EOVERFLOW watch",
    "revoked error ECANCELED watch",
    "ended close",
    "failed close",
    "overflowed close",
    "revoked close",
  ]);
  expect([world.closed.toSorted(), world.pending()]).toEqual([[40, 41, 42, 43], 0]);
});

test("a throwing change listener becomes an error event and releases the watch", () => {
  const world = fixture();
  const failure = new Error("listener failed");
  const errors: unknown[] = [];
  const watcher = world.module.watch("/a", () => { throw failure; });
  watcher.on("error", error => errors.push(error));
  world.commit(40, chunk(record("change", "x"), record("change", "y")));
  world.pump();
  expect([errors, world.closed, world.pending()]).toEqual([[failure], [40], 0]);
});

test("an invalid listener throws before any watch is opened", () => {
  const world = fixture();
  expect(() => world.module.watch("/app", {}, 42 as unknown as Listener)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect([world.opened, world.closed, world.pending()]).toEqual([[], [], 0]);
});

test("a construction failure after registration releases the watch and its waiter", () => {
  const world = fixture();
  const signal = new AbortController().signal;
  const failure = new Error("abort listener registry is full");
  Object.defineProperty(signal, "addEventListener", { value() { throw failure; } });
  expect(() => world.module.watch("/app", { signal })).toThrow(failure);
  expect(world.opened.map(({ id }) => id)).toEqual(world.closed);
  expect([world.closed.length, world.pending()]).toEqual([1, 0]);
});

test("watchers on the same descriptor identity, path and recursive flag share one native watch", () => {
  const world = fixture({ resolve: () => ({ dev: 1n, ino: 42n }) });
  const seenA: unknown[][] = [];
  const seenB: unknown[][] = [];
  const a = world.module.watch("/shared/file.txt", "utf8", (...args) => seenA.push(args));
  const b = world.module.watch("/shared/file.txt", "buffer", (...args) => seenB.push(args));
  const c = world.module.watch("/shared/file.txt", { recursive: true });
  expect(world.opened).toHaveLength(2);
  expect(world.droppedFds).toHaveLength(3);
  expect(world.pending()).toBe(1);
  world.commit(world.opened[0]!.id, chunk(record("change", null)));
  expect(world.pump()).toBe(true);
  expect(seenA).toEqual([["change", "file.txt"]]);
  const bName = seenB[0]?.[1];
  expect(Buffer.isBuffer(bName) && bName.toString()).toBe("file.txt");
  a.close();
  expect(world.closed).toEqual([]);
  expect(world.pending()).toBe(1);
  world.commit(world.opened[0]!.id, chunk(record("rename", null)));
  expect(world.pump()).toBe(true);
  expect(seenA).toHaveLength(1);
  expect(seenB).toHaveLength(2);
  b.unref();
  c.unref();
  expect(world.pending()).toBe(0);
  b.ref();
  expect(world.pending()).toBe(1);
  b.close();
  expect(world.closed).toEqual([world.opened[0]!.id]);
  c.close();
  expect(world.closed).toEqual([world.opened[0]!.id, world.opened[1]!.id]);
  expect(world.pending()).toBe(0);
});

test("late subscriber on a shared watch does not receive events queued before it registered", () => {
  const world = fixture({ resolve: () => ({ dev: 1n, ino: 77n }) });
  const events: string[] = [];
  const a = world.module.watch("/dir", (_event, name) => events.push(`A:${name}`));
  const watchId = world.opened[0]!.id;
  // Write occurs while only A is registered, before pump runs.
  world.commit(watchId, chunk(record("change", "old")));
  const b = world.module.watch("/dir", (_event, name) => events.push(`B:${name}`));
  expect(world.opened).toHaveLength(1);
  expect(world.pump()).toBe(true);
  expect(events).toEqual(["A:old"]);

  // Subsequent writes reach both A and B.
  world.commit(watchId, chunk(record("change", "new")));
  expect(world.pump()).toBe(true);
  expect(events).toEqual(["A:old", "A:new", "B:new"]);

  a.close();
  b.close();
  expect(world.closed).toEqual([watchId]);
});

test("late subscriber opens a fresh watch when existing shared watch has queued overflow", () => {
  const world = fixture({ resolve: () => ({ dev: 1n, ino: 88n }) });
  const errorsA: string[] = [];
  const eventsB: string[] = [];
  const a = world.module.watch("/dir");
  a.on("error", (err: { code: string }) => errorsA.push(err.code));
  const idA = world.opened[0]!.id;
  world.commit(idA, chunk(record("overflow")));
  const b = world.module.watch("/dir", (_event, name) => eventsB.push(String(name)));
  expect(world.opened).toHaveLength(2);
  const idB = world.opened[1]!.id;
  expect(world.pump()).toBe(true);
  expect(errorsA).toEqual(["EOVERFLOW"]);
  expect(world.closed).toEqual([idA]);

  world.commit(idB, chunk(record("change", "fresh")));
  expect(world.pump()).toBe(true);
  expect(eventsB).toEqual(["fresh"]);
  b.close();
  expect(world.closed).toEqual([idA, idB]);
});

test("sharing key derives from the opened descriptor and keeps full 64-bit inode width", () => {
  // Symlink target switches between inode 2 and inode 1: each open resolves its own fd identity.
  const resolvedInos = [2n, 1n, 2n];
  const openedInos: bigint[] = [];
  let cursor = 0;
  const world = fixture({
    resolve: () => {
      const ino = resolvedInos[cursor++]!;
      return { dev: 1n, ino };
    },
  });
  const origOpenFd = world.internal.native.fsWatchOpenFd;
  world.internal.native.fsWatchOpenFd = (fd: number, recursive: boolean) => {
    openedInos.push(resolvedInos[cursor - 1]!);
    return origOpenFd(fd, recursive);
  };
  const w1 = world.module.watch("/link");
  const w2 = world.module.watch("/link");
  const w3 = world.module.watch("/link");
  expect(openedInos).toEqual([2n, 1n]);
  expect(world.opened).toHaveLength(2);
  w1.close();
  w2.close();
  w3.close();

  // 64-bit inodes above 2^53 that collide in IEEE-754 Number must not share a watch.
  const wide = [9007199254740992n, 9007199254740993n];
  let wideAt = 0;
  const wideWorld = fixture({ resolve: () => ({ dev: 1n, ino: wide[wideAt++]! }) });
  const wa = wideWorld.module.watch("/same-path");
  const wb = wideWorld.module.watch("/same-path");
  expect(wideWorld.opened).toHaveLength(2);
  wa.close();
  wb.close();
});

test("unhandled overflow on one shared subscriber still delivers to remaining subscribers and propagates uncaught", () => {
  const world = fixture({ resolve: () => ({ dev: 1n, ino: 99n }) });
  const errorsB: string[] = [];
  const a = world.module.watch("/dir");
  const b = world.module.watch("/dir");
  b.on("error", (err: { code: string }) => errorsB.push(err.code));
  expect(world.opened).toHaveLength(1);
  const watchId = world.opened[0]!.id;
  expect(world.pending()).toBe(1);

  world.commit(watchId, chunk(record("overflow")));
  let caught: unknown;
  try {
    world.pump();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "EOVERFLOW", syscall: "watch" });
  expect(errorsB).toEqual(["EOVERFLOW"]);
  expect(world.closed).toEqual([watchId]);
  expect(world.pending()).toBe(0);
  expect(a).toBeDefined();
  expect(b).toBeDefined();
});

test("repeated joins bound the shared backlog and preserve provider overflow", () => {
  let nextId = 1;
  const queues = new Map<number, (Uint8Array | number)[]>();
  const overflowed = new Set<number>();
  const CAPACITY = 128;
  const world = fixture({ resolve: () => ({ dev: 1n, ino: 777n }) });
  world.internal.native.fsWatchOpenFd = () => {
    const id = nextId++;
    queues.set(id, []);
    return id;
  };
  world.internal.native.fsWatchReady = () =>
    Array.from(queues.entries()).some(([id, q]) => overflowed.has(id) || q.length > 0);
  world.internal.native.fsWatchRead = (id: number) => {
    if (overflowed.has(id)) return chunk(record("overflow"));
    const q = queues.get(id);
    if (!q || q.length === 0) return -6;
    const batch = Buffer.concat(q.splice(0, q.length) as Uint8Array[]);
    return batch;
  };
  world.internal.native.fsWatchNext = () => {
    const ready = Array.from(queues.keys()).find(id => overflowed.has(id) || queues.get(id)!.length > 0);
    return ready === undefined ? -6 : [ready, world.internal.native.fsWatchRead(ready)];
  };
  world.internal.native.fsWatchClose = (id: number) => {
    queues.delete(id);
    overflowed.delete(id);
    return 0;
  };

  const emitCreate = (name: string) => {
    for (const [id, q] of queues) {
      if (overflowed.has(id)) continue;
      if (q.length + 3 > CAPACITY) {
        q.length = 0;
        overflowed.add(id);
      } else {
        q.push(record("rename", name), record("change", name), record("change", name));
      }
    }
  };

  const eventsA: string[] = [];
  const errorsA: string[] = [];
  const a = world.module.watch("/dir", (_ev, name) => eventsA.push(String(name)));
  a.on("error", (err: { code: string }) => errorsA.push(err.code));

  for (let i = 0; i < 512; i++) {
    emitCreate(`f${i}`);
    const dup = world.module.watch("/dir");
    dup.close();
  }
  expect(world.pump()).toBe(true);
  expect(errorsA).toEqual(["EOVERFLOW"]);
  expect(eventsA.length).toBeLessThan(300);
});

test("a throwing iterator on the fsWatchResolve tuple still drops the resolved descriptor", () => {
  const world = fixture({ resolve: () => ({ dev: 1n, ino: 55n }) });
  const poisoned = [100, "1:55"] as [number, string];
  Object.defineProperty(poisoned, Symbol.iterator, {
    value() { throw new Error("iterator boom"); },
  });
  world.internal.native.fsWatchResolve = () => poisoned;
  const watcher = world.module.watch("/dir");
  expect(world.droppedFds).toEqual([100]);
  watcher.close();

  // Throwing when reading index 1 inside the protected scope also drops the descriptor.
  const badIdentity = [101] as unknown as [number, string];
  Object.defineProperty(badIdentity, 1, {
    get() { throw new Error("identity boom"); },
  });
  world.internal.native.fsWatchResolve = () => badIdentity;
  expect(() => world.module.watch("/dir")).toThrow("identity boom");
  expect(world.droppedFds).toEqual([100, 101]);
});

test("watch requires fsWatchResolve, fsWatchOpenFd, and fsWatchDropFd instead of falling back to fsWatchOpen", () => {
  const world = fixture({ resolve: () => ({ dev: 1n, ino: 66n }) });
  delete world.internal.native.fsWatchResolve;
  expect(() => world.module.watch("/dir")).toThrow();
  expect(world.opened).toHaveLength(0);
});

test("captureBoundary bounds both records (<=128) and bytes (<=16384) against a real Waffle WatchService", () => {
  function realWaffleHub() {
    const backend = new MemoryBackend();
    const service = new WatchService(backend);
    backend.execute("mkdirp", ["/short"], new Uint8Array());
    backend.execute("mkdirp", ["/long"], new Uint8Array());
    const root = backend.execute("preopen", ["/"], new Uint8Array()) as number;
    const handles = new Map<string, number>([
      ["/short", (backend.execute("resolve", [root, "short"], new Uint8Array()) as { node: number }).node],
      ["/long", (backend.execute("resolve", [root, "long"], new Uint8Array()) as { node: number }).node],
    ]);
    const table = new GuestWatchTable({
      cells: backend.shared.watch.cells,
      revoked: false,
      open: (handle, recursive) => service.open(1, handle, recursive, () => false),
      read: (id) => service.read(1, id),
      close: (id) => service.close(1, id),
    });
    const world = fixture();
    let opens = 0;
    let capturedBytes = 0;
    let capturedRecords = 0;
    let capturePhase = true;
    world.internal.native.fsWatchResolve = (path: string): [number, string] => {
      const handle = handles.get(path)!;
      return [handle, `1:${handle}`];
    };
    world.internal.native.fsWatchOpenFd = (fd: number, recursive: boolean) => {
      opens++;
      return table.open(fd, recursive);
    };
    world.internal.native.fsWatchDropFd = () => {};
    world.internal.native.fsWatchReady = () => table.ready();
    world.internal.native.fsWatchRead = (id: number, maxBytes?: number) => {
      try {
        const result = table.read(id, maxBytes ?? 65536);
        if (result.kind === "error") return -result.errno;
        if (result.kind === "short") return -42;
        if (capturePhase) {
          capturedRecords += result.records.length;
          capturedBytes += result.length;
        }
        return result.length ? Buffer.concat(result.records) : 0;
      } catch (error) {
        if (error instanceof FilesystemError) return -error.errno;
        throw error;
      }
    };
    world.internal.native.fsWatchNext = tableNext(table);
    world.internal.native.fsWatchClose = (id: number) => table.close(id);
    return {
      backend, world, table,
      opens: () => opens,
      captured: () => ({ records: capturedRecords, bytes: capturedBytes }),
      endCapture: () => { capturePhase = false; },
    };
  }

  // Record cap repro: 42 short creates + join, then 42 more short creates + join.
  const shortRun = realWaffleHub();
  const shortSeen = new Set<string>();
  const aShort = shortRun.world.module.watch("/short", (_type: string, name: string) => {
    shortSeen.add(name);
  });
  for (let i = 0; i < 42; i++) shortRun.backend.execute("writeFile", [`/short/f${i}`, false], new Uint8Array([1]));
  const dup1 = shortRun.world.module.watch("/short");
  dup1.close();
  for (let i = 42; i < 84; i++) shortRun.backend.execute("writeFile", [`/short/f${i}`, false], new Uint8Array([1]));
  const dup2 = shortRun.world.module.watch("/short");
  dup2.close();
  expect(shortRun.captured().records).toBeLessThanOrEqual(128);
  expect(shortRun.captured().bytes).toBeLessThanOrEqual(16 * 1024);
  expect(shortRun.opens()).toBeGreaterThan(1);
  shortRun.endCapture();
  // Pumping delivers both the buffered backlog and every excess record that stayed queued in Waffle.
  shortRun.world.pump();
  for (let i = 0; i < 84; i++) expect(shortSeen.has(`f${i}`)).toBe(true);
  aShort.close();

  // Byte cap repro: 28 creates + join, then 42 creates + join with 200-char name prefixes.
  const longRun = realWaffleHub();
  const prefix = "a".repeat(200);
  const longSeen = new Set<string>();
  const aLong = longRun.world.module.watch("/long", (_type: string, name: string) => {
    longSeen.add(name);
  });
  for (let i = 0; i < 28; i++) longRun.backend.execute("writeFile", [`/long/${prefix}${i}`, false], new Uint8Array([1]));
  const ldup1 = longRun.world.module.watch("/long");
  ldup1.close();
  for (let i = 28; i < 70; i++) longRun.backend.execute("writeFile", [`/long/${prefix}${i}`, false], new Uint8Array([1]));
  const ldup2 = longRun.world.module.watch("/long");
  ldup2.close();
  expect(longRun.captured().bytes).toBeLessThanOrEqual(16 * 1024);
  expect(longRun.captured().records).toBeLessThanOrEqual(128);
  expect(longRun.opens()).toBeGreaterThan(1);
  longRun.endCapture();
  longRun.world.pump();
  for (let i = 0; i < 70; i++) expect(longSeen.has(`${prefix}${i}`)).toBe(true);
  aLong.close();
});

test("writes under 1,500 watches reach their listeners through a few batched watch_next calls and no per-watch reads", () => {
  const backend = new MemoryBackend();
  const service = new WatchService(backend);
  const root = backend.execute("preopen", ["/"], new Uint8Array()) as number;
  const handles = new Map<string, number>();
  for (let index = 0; index < 1500; index++) {
    backend.execute("mkdirp", [`/app/d${index}`], new Uint8Array());
    handles.set(`/app/d${index}`, (backend.execute("resolve", [root, `app/d${index}`], new Uint8Array()) as { node: number }).node);
  }
  const calls = { read: 0, drain: 0, next: 0 };
  const table = new GuestWatchTable({
    cells: backend.shared.watch.cells,
    revoked: false,
    open: (handle, recursive) => service.open(1, handle, recursive, () => false),
    read: (id) => { calls.read++; return service.read(1, id); },
    drain: () => {
      calls.drain++;
      const held = service.drainHeld(1);
      try { return { entries: held.entries, more: held.more }; } finally { held.release(); }
    },
    close: (id) => service.close(1, id),
  });
  const world = fixture();
  const next = tableNext(table);
  // An empty identity never shares, so each path is its own registration.
  world.internal.native.fsWatchResolve = (path: string): [number, string] => [handles.get(path)!, ""];
  world.internal.native.fsWatchOpenFd = (fd: number, recursive: boolean) => table.open(fd, recursive);
  world.internal.native.fsWatchDropFd = () => {};
  world.internal.native.fsWatchReady = () => table.ready();
  world.internal.native.fsWatchRead = () => { throw new Error("the hub reads through fsWatchNext"); };
  world.internal.native.fsWatchNext = () => { calls.next++; return next(); };
  world.internal.native.fsWatchClose = (id: number) => table.close(id);
  const fired = new Set<string>();
  const files = new Set<string>();
  const watchers = Array.from(handles.keys(), path => world.module.watch(path, (type, name) => {
    fired.add(path);
    if (type === "rename") files.add(`${path}/${name}`);
  }));
  try {
    for (const index of [3, 700, 1499]) backend.execute("writeFile", [`/app/d${index}/page.ts`, false], new Uint8Array([1]));
    expect(world.pump()).toBe(true);
    expect(Array.from(fired).toSorted()).toEqual(["/app/d1499", "/app/d3", "/app/d700"]);
    expect(Array.from(files).toSorted()).toEqual(["/app/d1499/page.ts", "/app/d3/page.ts", "/app/d700/page.ts"]);
    expect(calls.read).toBe(0);
    expect(calls.drain).toBeGreaterThan(0);
    expect(calls.next).toBeLessThan(10);
  } finally { for (const watcher of watchers) watcher.close(); }
});

test("an unscoped watch_next error fails every watch, and an unknown id is released", () => {
  const world = fixture();
  const errors: string[] = [];
  const watchers = ["/a", "/b"].map(path => world.module.watch(path).on("error", (error: { code: string }) => errors.push(`${path} ${error.code}`)));
  const results: ([number, Uint8Array | number] | number)[] = [[99, chunk(record("change", "x"))], -29];
  world.internal.native.fsWatchReady = () => results.length > 0;
  world.internal.native.fsWatchNext = () => results.shift() ?? -6;
  expect(world.pump()).toBe(true);
  expect(world.closed.toSorted()).toEqual([40, 41, 99]);
  expect(errors).toEqual(["/a EIO", "/b EIO"]);
  expect(world.pending()).toBe(0);
  for (const watcher of watchers) watcher.close();
});

test("an unhandled unscoped watch_next error still fails and closes remaining watches", () => {
  const world = fixture();
  const errors: string[] = [];
  const first = world.module.watch("/a");
  const second = world.module.watch("/b").on("error", (error: { code: string }) => errors.push(error.code));
  world.internal.native.fsWatchReady = () => true;
  world.internal.native.fsWatchNext = () => -29;
  expect(() => world.pump()).toThrow("EIO");
  expect(world.closed.toSorted()).toEqual([40, 41]);
  expect(errors).toEqual(["EIO"]);
  expect(world.pending()).toBe(0);
  first.close();
  second.close();
});
