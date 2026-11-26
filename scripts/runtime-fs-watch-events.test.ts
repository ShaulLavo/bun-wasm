import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resourceFrames } from "./resource-frame-source";
import { GuestWatchTable } from "../web/node_modules/waffle/fs/guest-watch.ts";
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

function fixture(options: { resolve?: (path: string) => { dev?: bigint; ino: bigint } | number } = {}) {
  const queued = new Map<number, (Uint8Array | number)[]>();
  const opened: { path: string; recursive: boolean; id: number; fd?: number }[] = [];
  const closed: number[] = [];
  const droppedFds: number[] = [];
  const fdToPath = new Map<number, string>();
  const ticks: (() => void)[] = [];
  const effects = { stats: 0, timers: 0, scans: 0 };
  const traffic = { readiness: 0, reads: 0 };
  let nextId = 40;
  let nextFd = 100;
  let openResult: number | undefined;
  let net: unknown;
  const resolveNatives = options.resolve
    ? {
        fsWatchResolve(path: string): [number, string] | number {
          const resolved = options.resolve!(path);
          if (typeof resolved === "number") return resolved;
          const fd = nextFd++;
          fdToPath.set(fd, path);
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
      }
    : {};
  const internal: any = {
    native: {
      hostCaps: {},
      ...resolveNatives,
      fsWatchOpen(path: string, recursive: boolean) {
        if (openResult !== undefined) return openResult;
        const id = nextId++;
        opened.push({ path, recursive, id });
        queued.set(id, []);
        return id;
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
    expect(world.traffic).toEqual({ readiness: 10, reads: 0 });
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
  world.internal.native.fsWatchOpen = (_path: string, recursive: boolean) => id = table.open(1, recursive);
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
  expect(world.effects).toEqual({ stats: 1, timers: 0, scans: 0 });
  expect(world.opened).toEqual([{ path: "/app", recursive: true, id: 40 }]);
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
