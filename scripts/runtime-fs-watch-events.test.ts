import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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

function fixture() {
  const queued = new Map<number, (Uint8Array | number)[]>();
  const opened: { path: string; recursive: boolean; id: number }[] = [];
  const closed: number[] = [];
  const ticks: (() => void)[] = [];
  const effects = { stats: 0, timers: 0, scans: 0 };
  let nextId = 40;
  let openResult: number | undefined;
  let net: unknown;
  const internal: any = {
    native: {
      hostCaps: {},
      fsWatchOpen(path: string, recursive: boolean) {
        if (openResult !== undefined) return openResult;
        const id = nextId++;
        opened.push({ path, recursive, id });
        queued.set(id, []);
        return id;
      },
      fsWatchRead(id: number) {
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
    module, opened, closed, effects, internal,
    commit(id: number, ...results: (Uint8Array | number)[]) { queued.get(id)!.push(...results); },
    failOpen(errno: number) { openResult = -errno; },
    pump: (): boolean => internal.pumpIo(),
    pending: (): number => internal.ioPending(),
    runTicks() { while (ticks.length) ticks.shift()!(); },
  };
}

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
