import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";

type Waiter = { ref: boolean; step(): boolean | "progress"; fail(error: unknown): void; subscriptions?(): Uint8Array };
const stripTypeScriptTypes = (text: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${text}`) + ";globalThis.factory";
const source = readFileSync(process.env.STDIO_FACTORY ?? new URL("../crates/bunwasm-runtime/src/js/process.ts", import.meta.url), "utf8");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const waiters = new Set<Waiter>();
  const chunks: (Uint8Array | number)[] = [];
  const closes: number[] = [];
  const reads: number[] = [];
  const native = {
    platformInfo: {}, env: () => ({}), argv: () => ["bun"], execPath: () => "/bin/bun", isatty: () => false,
    hostSignal: () => 0,
    readStdin() { throw new Error("synchronous read-to-EOF must not run"); },
    procRead(fd: number, size: number) { expect(fd).toBe(0); reads.push(size); return chunks.shift() ?? -6; },
    procClose(fd: number) { closes.push(fd); return 0; },
  };
  const internal = {
    native, realTimers: { setImmediate }, nextTick: process.nextTick,
    builtin: () => ({ Readable }),
    addIoWaiter(waiter: Waiter) { waiters.add(waiter); return waiter; },
    require(name: string): unknown {
      if (name === "events") return require("node:events");
      if (name === "process_signals") return () => () => false;
      if (name === "buffer") return { Buffer };
      if (name === "net") return {};
      if (name === "process_stdin") {
        const text = readFileSync(new URL("../crates/bunwasm-runtime/src/js/process_stdin.ts", import.meta.url), "utf8");
        return runInNewContext(stripTypeScriptTypes(text), { Uint8Array, DataView, Error })(internal);
      }
      throw new Error(`unexpected module ${name}`);
    },
  };
  const guest = runInNewContext(stripTypeScriptTypes(source), { Uint8Array, DataView, Error })(internal);
  function stepWaiter(waiter: Waiter) {
    try { if (waiter.step() === true) waiters.delete(waiter); }
    catch (error) { waiters.delete(waiter); waiter.fail(error); }
  }
  function pump() {
    for (const waiter of Array.from(waiters)) stepWaiter(waiter);
  }
  return { stdin: guest.stdin as Readable & { ref(): void; unref(): void }, guest, waiters, chunks, reads, closes, pump };
}

test("flowing stdin delivers before EOF and yields while input remains open", async () => {
  const f = fixture();
  const seen: string[] = [];
  expect(f.guest.stdin).toBe(f.stdin);
  f.stdin.setEncoding("utf8");
  f.stdin.on("data", chunk => seen.push(chunk));
  await tick();
  f.pump();
  expect(seen).toEqual([]);
  expect(f.waiters.size).toBe(1);
  expect(f.waiters.values().next().value?.subscriptions?.()).toEqual(new Uint8Array(16));
  f.chunks.push(Buffer.from("hello\n"));
  f.pump();
  await tick();
  expect(seen).toEqual(["hello\n"]);
  let timer = false;
  await new Promise<void>(resolve => setTimeout(() => { timer = true; resolve(); }, 1));
  expect(timer).toBe(true);
  expect(f.stdin.readableEnded).toBe(false);
  f.chunks.push(0);
  f.pump();
  await tick();
  expect(f.stdin.readableEnded).toBe(true);
  expect(f.waiters.size).toBe(0);
});

test("paused and slow iterator consumers buffer at most the high water mark", async () => {
  const f = fixture();
  f.stdin.on("data", () => f.stdin.pause());
  f.chunks.push(Buffer.alloc(65536), Buffer.alloc(65536), Buffer.from("tail"), 0);
  await tick();
  f.pump();
  await tick();
  for (let index = 0; index < 10; index++) { f.pump(); await tick(); }
  expect(f.stdin.readableLength).toBeLessThanOrEqual(65536);
  expect(f.reads.length).toBeLessThanOrEqual(2);
  expect(f.chunks.length).toBeGreaterThanOrEqual(2);
  f.stdin.removeAllListeners("data");
  const iterator = f.stdin[Symbol.asyncIterator]();
  const next = iterator.next();
  f.pump();
  expect((await next).done).toBe(false);
  await iterator.return?.();
  f.pump();
  expect(f.stdin.destroyed).toBe(true);
  expect(f.waiters.size).toBe(0);
  expect(f.closes).toEqual([0]);
});

test("destroy cancels pending reads and drops their event-loop reference", async () => {
  const f = fixture();
  f.stdin.resume();
  await tick();
  f.stdin.unref();
  expect(Array.from(f.waiters, waiter => waiter.ref)).toEqual([false]);
  f.stdin.ref();
  expect(Array.from(f.waiters, waiter => waiter.ref)).toEqual([true]);
  f.stdin.destroy();
  expect(Array.from(f.waiters, waiter => waiter.ref)).toEqual([false]);
  f.chunks.push(Buffer.from("too late"));
  f.pump();
  await tick();
  expect(f.waiters.size).toBe(0);
  expect(f.reads).toEqual([]);
  expect(f.closes).toEqual([0]);
});

test("read errors preserve WASI error names and terminate the waiter", async () => {
  const f = fixture();
  const error = new Promise<Error & { code: string }>(resolve => f.stdin.once("error", resolve));
  f.chunks.push(-8);
  f.stdin.resume();
  await tick();
  f.pump();
  expect((await error).code).toBe("EBADF");
  expect(f.waiters.size).toBe(0);
  expect(f.stdin.destroyed).toBe(true);
});

test("UTF-8 decoding spans chunks, and readable mode can consume EOF once", async () => {
  const f = fixture();
  const seen: string[] = [];
  f.stdin.setEncoding("utf8");
  f.stdin.on("readable", () => {
    for (let chunk; (chunk = f.stdin.read()) !== null;) seen.push(chunk);
  });
  f.chunks.push(new Uint8Array([0xe2]), new Uint8Array([0x82, 0xac]), 0);
  await tick();
  f.pump();
  await tick();
  f.pump();
  await tick();
  f.pump();
  await tick();
  expect(seen.join("")).toBe("€");
  expect(f.stdin.readableEnded).toBe(true);
  expect(f.stdin.read()).toBe(null);
  expect((await f.stdin[Symbol.asyncIterator]().next()).done).toBe(true);
  expect(f.reads.length).toBe(3);
});

test("async iteration delivers a chunk without waiting for EOF", async () => {
  const f = fixture();
  const iterator = f.stdin[Symbol.asyncIterator]();
  const first = iterator.next();
  f.pump();
  await tick();
  expect(f.waiters.size).toBe(1);
  f.chunks.push(Buffer.from("request"));
  f.pump();
  expect(String((await first).value)).toBe("request");
  expect(f.stdin.readableEnded).toBe(false);
  f.chunks.push(0);
  const last = iterator.next();
  f.pump();
  expect((await last).done).toBe(true);
  expect(f.waiters.size).toBe(0);
});
