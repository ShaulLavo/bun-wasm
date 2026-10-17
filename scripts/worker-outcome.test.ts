import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.workerFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/worker_threads.ts", import.meta.url), "utf8")}`);

function receiver() {
  const immediate: (() => void)[] = [];
  const frames: unknown[] = [];
  let ended = false;
  let closed = 0;
  let resolveExit!: (status: number) => void;
  const child = {
    pid: 71, signalCode: null as string | null,
    stdout: {}, stderr: {}, stdin: null,
    exited: new Promise<number>(resolve => { resolveExit = resolve; }),
    kill() {}, ref() {}, unref() {}, _finishWorker() { closed++; }, _abortWorker() {},
  };
  const factory = runInNewContext(source, {
    EventTarget, Event, MessageEvent, DOMException, URL, structuredClone,
  });
  const modules: Record<string, unknown> = {
    process: { env: {}, execArgv: [], execPath: "bun", cwd: () => "/" },
    events: EventEmitter, structured_clone: { structuredClone }, net: {},
    worker_codec: { create: () => ({
      prepare: () => ({ graph: { nodes: [] }, commit() {} }), decode: (value: unknown) => value,
    }) },
    spawn: { spawn: () => child },
    worker_channel: { open: () => ({
      send() {}, close() {}, get ended() { return ended; },
      pump(receive: (frame: unknown) => void) { for (const frame of frames.splice(0)) receive(frame); return false; },
    }) },
    worker_stdio: { readable: () => ({ stream: new EventEmitter(), drained: Promise.resolve() }) },
  };
  const implementation = factory({
    realTimers: { setImmediate(callback: () => void) { immediate.push(callback); } },
    native: { hostChildPipe: (_pid: number, selector: number) => selector },
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
      return modules[name];
    },
    addIoWaiter() {}, messagePortRefs: 0,
  });
  const worker = new implementation.Worker("", { eval: true, stdout: true, stderr: true });
  const errors: Error[] = [];
  const exits: number[] = [];
  worker.on("error", (error: Error) => errors.push(error));
  worker.on("exit", (status: number) => exits.push(status));
  return {
    worker, errors, exits, closed: () => closed,
    event(body: Record<string, unknown>) { frames.push({ kind: "down", path: [], body: Object.assign({ child: 0 }, body) }); },
    async finish(status: number, signal: string | null) {
      child.signalCode = signal;
      ended = true;
      resolveExit(status);
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve();
        for (const callback of immediate.splice(0)) callback();
      }
      expect(immediate).toHaveLength(0);
      expect(closed).toBe(1);
    },
  };
}

for (const [status, signal] of [[141, "SIGPIPE"], [143, "SIGTERM"], [137, "SIGKILL"]] as const) {
  test(`worker receiver does not synthesize an error for typed ${signal} death`, async () => {
    const f = receiver();
    await f.finish(status, signal);
    expect(f.exits).toEqual([status]);
    expect(f.errors).toEqual([]);
  });
}

for (const status of [141, 143, 137]) {
  test(`worker receiver preserves ordinary nongraceful crash ${status} as an error`, async () => {
    const f = receiver();
    await f.finish(status, null);
    expect(f.exits).toEqual([status]);
    expect(f.errors.map(error => error.message)).toEqual([`Worker exited with code ${status}`]);
  });
}

test("worker receiver retains graceful ordinary status 141 without an error", async () => {
  const f = receiver();
  f.event({ kind: "exiting", messages: 0 });
  await f.finish(141, null);
  expect(f.exits).toEqual([141]);
  expect(f.errors).toEqual([]);
});

test("worker receiver forwards a genuine error frame without a duplicate synthetic error", async () => {
  const f = receiver();
  const error = new Error("genuine child failure");
  f.event({ kind: "error", graph: error });
  await f.finish(1, null);
  expect(f.exits).toEqual([1]);
  expect(f.errors).toEqual([error]);
});

test("worker receiver retains termination's own exit code without synthesizing an error", async () => {
  const f = receiver();
  const terminated = f.worker.terminate();
  await f.finish(137, "SIGKILL");
  expect(await terminated).toBe(1);
  expect(f.exits).toEqual([1]);
  expect(f.errors).toEqual([]);
});
