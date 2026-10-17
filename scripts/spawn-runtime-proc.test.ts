import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import * as nodePath from "node:path";
import { runInNewContext } from "node:vm";

// spawn.ts against an in-memory runtime_proc service: descriptors, pipes with reference counts,
// typed wait and job reaping. Real hosts are covered by the browser, Node and native ABI suites.
const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.spawnFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/spawn.ts", import.meta.url), "utf8")}`);

const EAGAIN = -6;
const ENOENT = -44;

interface FakePipe { chunks: Uint8Array[]; readers: number; writers: number }
interface FakeChild {
  pid: number; job: number; request: Record<string, any>; status: [number, number] | null;
  held: Map<number, { pipe: FakePipe; write: boolean }>; reaped: boolean;
}

function service(options: { failSpawn?: number } = {}) {
  const pipes = new Map<number, { pipe: FakePipe; write: boolean }>();
  const children = new Map<number, FakeChild>();
  const calls: string[] = [];
  let next = 5;
  let pid = 100;
  const release = (entry: { pipe: FakePipe; write: boolean }) => { if (entry.write) entry.pipe.writers--; else entry.pipe.readers--; };
  const retain = (entry: { pipe: FakePipe; write: boolean }) => { if (entry.write) entry.pipe.writers++; else entry.pipe.readers++; };
  const stop = (child: FakeChild, kind: number, code: number) => {
    if (child.status) return;
    child.status = [kind, code];
    for (const entry of child.held.values()) release(entry);
    child.held.clear();
  };
  const native: Record<string, any> = {
    hostCaps: { proc_spawn: true }, cwd: () => "/work", now: () => Date.now(),
    procPipe() {
      const pipe: FakePipe = { chunks: [], readers: 1, writers: 1 };
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
      const child: FakeChild = { pid: pid++, job: 7 + children.size, request, status: null, held: new Map(), reaped: false };
      for (const { child: number, parent } of request.fds) {
        const entry = pipes.get(parent);
        if (!entry) continue; // inherited stdio: not a pipe
        retain(entry);
        child.held.set(number, entry);
      }
      children.set(child.pid, child);
      return child.pid;
    },
    ownJob: 0,
    procJobOf(id: number) { return id === 0 ? this.ownJob || -71 : children.get(id)?.job ?? -71; },
    procRead(fd: number) {
      const entry = pipes.get(fd);
      if (!entry) return -8;
      const chunk = entry.pipe.chunks.shift();
      if (chunk) return chunk;
      return entry.pipe.writers === 0 ? 0 : EAGAIN;
    },
    procWrite(fd: number, bytes: Uint8Array) {
      const entry = pipes.get(fd);
      if (!entry) return -8;
      if (entry.pipe.readers === 0) return -64;
      entry.pipe.chunks.push(bytes.slice());
      return bytes.length;
    },
    procWait(id: number) {
      const child = children.get(id);
      if (!child || child.reaped) return -12;
      return child.status ?? EAGAIN;
    },
    procWaitJob(job: number) {
      const child = Array.from(children.values()).find((candidate) => candidate.job === job);
      if (!child || child.reaped) return -12;
      if (!child.status) return EAGAIN;
      child.reaped = true;
      calls.push("reap");
      return child.status[0] ? 128 + child.status[1] : child.status[1];
    },
    procKill(id: number, signal: number) {
      const child = children.get(id);
      if (!child) return -71;
      stop(child, 1, signal);
      return 0;
    },
    procKillJob(job: number, signal: number) {
      const child = Array.from(children.values()).find((candidate) => candidate.job === job);
      if (!child) return -71;
      stop(child, 1, signal);
      return 0;
    },
    procPoll(subscriptions: Uint8Array) { calls.push(`poll:${subscriptions.length / 16}`); return new Uint8Array(0); },
  };
  return {
    native, calls, children, pipes,
    exit(child: FakeChild, code: number) { stop(child, 0, code); },
    /** What a child process would write to its descriptor. */
    childWrite(child: FakeChild, fd: number, text: string) {
      const entry = child.held.get(fd)!;
      entry.pipe.chunks.push(new TextEncoder().encode(text));
    },
    childRead(child: FakeChild, fd: number) {
      const entry = child.held.get(fd)!;
      const chunk = entry.pipe.chunks.shift();
      return chunk ? new TextDecoder().decode(chunk) : entry.pipe.writers === 0 ? null : "";
    },
    open: () => pipes.size,
  };
}

function load(fake: ReturnType<typeof service>) {
  const waiters: any[] = [];
  const factory = runInNewContext(source, {
    ReadableStream, Response, URL, TextEncoder, TextDecoder, Promise,
    process: { env: { HOME: "/home" }, execArgv: [], execPath: "bun", cwd: () => "/work" },
  });
  const modules: Record<string, unknown> = { buffer: { Buffer }, path: nodePath, net: {} };
  const internal = {
    native: fake.native,
    web: { ReadableStream, Response },
    realTimers: { setTimeout, clearTimeout, setImmediate },
    toUint8: (value: ArrayBufferView) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    concatBytes: (chunks: Uint8Array[]) => Buffer.concat(chunks),
    nextTick: (callback: () => void) => queueMicrotask(callback),
    addIoWaiter(waiter: any) { waiters.push(waiter); return waiter; },
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
      return modules[name];
    },
  };
  const module = factory(internal);
  /** Runs every waiter's step until it finishes, like the event loop's pumpIo. */
  const pump = async (limit = 50) => {
    for (let turn = 0; turn < limit; turn++) {
      for (const waiter of waiters.slice()) {
        if (waiter.step() === true) waiters.splice(waiters.indexOf(waiter), 1);
      }
      await Promise.resolve();
      if (!waiters.length) return;
    }
    throw new Error("waiters did not finish");
  };
  return { module, waiters, pump };
}

function decode(subscriptions: Uint8Array) {
  const view = new DataView(subscriptions.buffer, subscriptions.byteOffset, subscriptions.byteLength);
  return Array.from({ length: subscriptions.length / 16 }, (_, i) => [view.getUint32(i * 16, true), view.getUint32(i * 16 + 4, true)]);
}

test("pipes bind to child descriptors, the parent drops its child ends, and the job is reaped", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const child = module.spawn(["bun", "-e", "1"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { A: "1" }, cwd: "/tmp" });
  const record = fake.children.get(child.pid)!;
  expect(record.request).toMatchObject({ executable: "bun", argv: ["bun", "-e", "1"], env: { A: "1" }, cwd: "/tmp", job: 0 });
  const bindings = record.request.fds;
  expect(bindings.map((b: any) => b.child)).toEqual([0, 1, 2]);
  expect(bindings[2]).toEqual({ child: 2, parent: 2 });
  // Stdin/stdout ends held by the parent (write, read) plus the child's references: nothing else.
  expect(Array.from(record.held.keys())).toEqual([0, 1]);
  expect(fake.pipes.size).toBe(2);

  child.stdin.write("ping");
  expect(fake.childRead(record, 0)).toBe("ping");
  child.stdin.end();
  fake.childWrite(record, 1, "pong");
  fake.exit(record, 3);
  await pump();
  expect(await child.exited).toBe(3);
  expect(child.exitCode).toBe(3);
  expect(child.signalCode).toBeNull();
  expect(await child.stdout.text()).toBe("pong");
  expect(record.reaped).toBe(true);
  expect(fake.pipes.size).toBe(0);
});

test("a selected signal death is a signal, an ordinary 143 is not", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const killed = module.spawn(["bun", "a"], { stdout: "pipe" });
  killed.kill("SIGTERM");
  await pump();
  expect(await killed.exited).toBe(143);
  expect(killed.signalCode).toBe("SIGTERM");
  expect(killed.exitCode).toBeNull();
  expect(killed.killed).toBe(true);

  const ordinary = module.spawn(["bun", "b"], { stdout: "pipe" });
  fake.exit(fake.children.get(ordinary.pid)!, 143);
  await pump();
  expect(await ordinary.exited).toBe(143);
  expect(ordinary.signalCode).toBeNull();
  expect(ordinary.exitCode).toBe(143);
});

test("ignored stdio has no stream: stdin reads EOF, output is drained and dropped", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const child = module.spawn(["bun", "x"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const record = fake.children.get(child.pid)!;
  expect(child.stdin).toBeNull();
  expect(child.stdout).toBeNull();
  expect(child.stderr).toBeNull();
  expect(fake.childRead(record, 0)).toBeNull(); // no writer left: end of file
  fake.childWrite(record, 1, "dropped");
  fake.childWrite(record, 2, "dropped");
  fake.exit(record, 0);
  await pump();
  expect(await child.exited).toBe(0);
  expect(fake.pipes.size).toBe(0);
});

test("a failed spawn throws the errno and leaks no descriptors", () => {
  const fake = service({ failSpawn: ENOENT });
  const { module } = load(fake);
  expect(() => module.spawn(["nope"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })).toThrow(/spawn nope ENOENT/);
  expect(fake.open()).toBe(0);
  const result = module.spawnSync(["nope"], {});
  expect(result.success).toBe(false);
  expect(result.error.code).toBe("ENOENT");
  expect(fake.open()).toBe(0);
});

test("worker children get two bound control pipes announced through the environment", () => {
  const fake = service();
  const { module } = load(fake);
  const child = module.spawn(["bun", "w"], { stdout: "pipe", stderr: "pipe", env: { K: "v" }, _worker: { memoryLimitMb: 64 } });
  const request = fake.children.get(child.pid)!.request;
  const control = JSON.parse(request.env.BUNWASM_WORKER_CONTROL);
  const extra = request.fds.filter((binding: any) => binding.child > 2);
  expect(extra.map((binding: any) => binding.child)).toEqual([control.input, control.output]);
  expect(extra.every((binding: any) => binding.child === binding.parent)).toBe(true);
  expect(request.worker).toEqual({ memoryLimitMb: 64 });
  expect(request.env.K).toBe("v");
  // The parent keeps the other ends: it reads what the worker writes and writes what it reads.
  const { input, output } = child._workerChannel;
  expect(new Set([input, output, control.input, control.output]).size).toBe(4);
  expect(fake.native.procWrite(output, new TextEncoder().encode("hi"))).toBe(2);
  expect(fake.childRead(fake.children.get(child.pid)!, control.input)).toBe("hi");
  fake.childWrite(fake.children.get(child.pid)!, control.output, "ok");
  expect(new TextDecoder().decode(fake.native.procRead(input, 16) as Uint8Array)).toBe("ok");
});

test("the idle loop sleeps on exactly the descriptors and child the waiter watches", () => {
  const fake = service();
  const { module, waiters } = load(fake);
  const child = module.spawn(["bun", "s"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const record = fake.children.get(child.pid)!;
  const kinds = () => decode(waiters[0].subscriptions());
  // stdout readable and the child exit; stdin has nothing queued to write.
  expect(kinds().map(([kind]) => kind)).toEqual([0, 2]);
  expect(kinds()[1][1]).toBe(child.pid);
  fake.childWrite(record, 1, "tail");
  fake.exit(record, 0);
  waiters[0].step();
  // Exited and reaped, but output is still being drained: only the pipe remains.
  expect(kinds().map(([kind]) => kind)).toEqual([0]);
  waiters[0].step();
  expect(kinds()).toEqual([]);
});

test("spawnSync collects output, classifies the exit and reaps the job", () => {
  const fake = service();
  const { module } = load(fake);
  const original = fake.native.procPoll;
  fake.native.procPoll = (subscriptions: Uint8Array) => {
    original(subscriptions);
    // The child runs while the parent sleeps: it answers on stdout, then exits 7.
    const record = Array.from(fake.children.values())[0];
    if (record && !record.status) { fake.childWrite(record, 1, "out"); fake.childWrite(record, 2, "err"); fake.exit(record, 7); }
    return new Uint8Array(0);
  };
  const result = module.spawnSync(["bun", "sync"], { stdin: new Uint8Array([1, 2, 3]) });
  expect(result.exitCode).toBe(7);
  expect(result.signalCode).toBeNull();
  expect(result.success).toBe(false);
  expect(result.stdout.toString()).toBe("out");
  expect(result.stderr.toString()).toBe("err");
  expect(fake.calls).toContain("reap");
  expect(fake.pipes.size).toBe(0);
});

test("spawnSync timeout kills with the requested signal and reports it", () => {
  const fake = service();
  const { module } = load(fake);
  const result = module.spawnSync(["bun", "slow"], { timeout: 1, killSignal: "SIGKILL" });
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.signalCode).toBe("SIGKILL");
  expect(result.exitCode).toBeNull();
  expect(result.success).toBe(false);
  expect(fake.pipes.size).toBe(0);
});

test("a caller with a job puts children in it and never reaps or kills the shared job", async () => {
  const fake = service();
  fake.native.ownJob = 3;
  const { module, pump } = load(fake);
  const child = module.spawn(["bun", "j"], { stdout: "pipe" });
  const record = fake.children.get(child.pid)!;
  expect(record.request.job).toBe(3);
  fake.exit(record, 0);
  await pump();
  expect(await child.exited).toBe(0);
  expect(fake.calls).not.toContain("reap");
  const sync = module.spawnSync(["bun", "k"], { timeout: 1, killSignal: "SIGKILL" });
  expect(sync.signalCode).toBe("SIGKILL");
  expect(fake.calls).not.toContain("reap");
});
