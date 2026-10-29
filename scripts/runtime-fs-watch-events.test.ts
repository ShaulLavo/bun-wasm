import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The shipped watcher and the real net.js waiter scheduler over a fake runtime_proc watch
// descriptor: watch_open, then read() returning packed records, -EAGAIN or 0 at the end.
// Everything is per-fixture memory; no timers, files or processes need teardown.
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
type Waiter = { ref: boolean; late?: boolean; step(): boolean | "progress"; subscriptions?(): Uint8Array };

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpile = (name: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${readFileSync(new URL(name, directory), "utf8")}`);

const encoder = new TextEncoder();
function record(type: "change" | "rename" | "overflow", name?: string | null) {
  const bytes = name == null ? new Uint8Array(0) : encoder.encode(name);
  const out = new Uint8Array(8 + bytes.length);
  out[0] = { change: 1, rename: 2, overflow: 3 }[type];
  new DataView(out.buffer).setUint32(4, name == null ? 0xffffffff : bytes.length, true);
  out.set(bytes, 8);
  return out;
}
const chunk = (...records: Uint8Array[]) => Buffer.concat(records);

function fixture() {
  const queued = new Map<number, (Uint8Array | number)[]>();
  const opened: { path: string; recursive: boolean; fd: number }[] = [];
  const closed: number[] = [];
  const ticks: (() => void)[] = [];
  const effects = { stats: 0, timers: 0, scans: 0 };
  let nextFd = 40;
  let openResult: number | undefined;
  let net: unknown;
  const internal: any = {
    native: {
      hostCaps: {},
      fsWatchOpen(path: string, recursive: boolean) {
        if (openResult !== undefined) return openResult;
        const fd = nextFd++;
        opened.push({ path, recursive, fd });
        queued.set(fd, []);
        return fd;
      },
      procRead(fd: number) {
        if (closed.includes(fd)) return -8;
        return queued.get(fd)?.shift() ?? -6;
      },
      procClose(fd: number) { closed.push(fd); return 0; },
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
    commit(fd: number, ...results: (Uint8Array | number)[]) { queued.get(fd)!.push(...results); },
    failOpen(errno: number) { openResult = -errno; },
    pump: (): boolean => internal.pumpIo(),
    pending: (): number => internal.ioPending(),
    runTicks() { while (ticks.length) ticks.shift()!(); },
  };
}

test("a committed write reaches change listeners in the same pump as later socket bytes, with no timer", () => {
  const world = fixture();
  const log: string[] = [];
  const watcher = world.module.watch("/app", { recursive: true }, (event, name) => log.push(`${event} ${name}`));
  const fd = world.opened[0]!.fd;
  let reloadSent = true;
  // The edit commits, then the browser's reload bytes become readable. Both happen while the
  // pump is running, after the watch was registered (and possibly already stepped).
  world.internal.addIoWaiter({
    step() {
      if (!reloadSent) return false;
      reloadSent = false;
      world.commit(fd, chunk(record("change", "page.tsx")));
      log.push("request");
      return "progress";
    },
  });
  world.pump();
  expect(log).toEqual(["request", "change page.tsx"]);
  expect(world.effects).toEqual({ stats: 1, timers: 0, scans: 0 });
  expect(world.opened).toEqual([{ path: "/app", recursive: true, fd: 40 }]);
  watcher.close();
});

test("one step drains every queued record until EAGAIN", () => {
  const world = fixture();
  const events: unknown[][] = [];
  world.module.watch("/dir", (...args) => events.push(args));
  const fd = world.opened[0]!.fd;
  world.commit(fd, chunk(record("rename", "a"), record("change", "sub/b")), chunk(record("change", "a")));
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

test("registration failure throws a watch error and leaves nothing registered", () => {
  const world = fixture();
  world.failOpen(44);
  expect(() => world.module.watch("/gone")).toThrow(expect.objectContaining({ code: "ENOENT", errno: -2, syscall: "watch", path: "/gone" }));
  expect(world.pending()).toBe(0);
});

test("the waiter sleeps on a READABLE subscription for the watch descriptor", () => {
  const world = fixture();
  const added: Waiter[] = [];
  const add = world.internal.addIoWaiter;
  world.internal.addIoWaiter = (waiter: Waiter) => { added.push(waiter); return add(waiter); };
  world.module.watch("/dir");
  const subscription = added[0]!.subscriptions!();
  const view = new DataView(subscription.buffer, subscription.byteOffset, 16);
  expect([subscription.length, view.getUint32(0, true), view.getUint32(4, true)]).toEqual([16, 0, 40]);
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

test("close is idempotent, releases the descriptor and emits close once on a later tick", () => {
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
  world.commit(40, 0);
  world.commit(41, -29);
  world.commit(42, chunk(record("change", "kept"), record("overflow"), record("change", "dropped")));
  world.pump();
  world.runTicks();
  expect(outcomes).toEqual([
    "failed error EIO watch",
    "overflowed change kept",
    "overflowed error EOVERFLOW watch",
    "ended close",
    "failed close",
    "overflowed close",
  ]);
  expect([world.closed.toSorted(), world.pending()]).toEqual([[40, 41, 42], 0]);
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
