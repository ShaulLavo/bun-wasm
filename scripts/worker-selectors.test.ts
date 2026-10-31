import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.workerFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/worker_threads.ts", import.meta.url), "utf8")}`);

function workerModule(self: boolean, control: unknown = { input: 12, output: 15 }) {
  const channels: number[][] = [];
  const stop = new Error("channel opened");
  const factory = runInNewContext(source, {
    EventTarget, Event, MessageEvent, DOMException, URL, structuredClone,
  });
  const process = {
    env: self ? {
      BUNWASM_WORKER_INIT: JSON.stringify({ route: [1], envGroup: "worker", argv: ["bun", "[worker eval]"], execArgv: [], graph: {} }),
      ...(control === null ? {} : { BUNWASM_WORKER_CONTROL: JSON.stringify(control) }),
    } : {},
    execArgv: [], execPath: "bun", cwd: () => "/",
  };
  const modules: Record<string, unknown> = {
    process, events: EventEmitter, structured_clone: { structuredClone }, net: {},
    worker_codec: { create: () => ({ prepare: () => ({ graph: {}, commit() {}, abort() {} }) }) },
    spawn: { spawn: () => ({ pid: 71, _workerChannel: { input: 21, output: 22 }, _abortWorker() {} }) },
    worker_channel: { open: (read: number, write: number) => {
      channels.push([read, write]);
      throw stop;
    } },
  };
  const implementation = factory({
    realTimers: { setImmediate() {} },
    native: {},
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
      return modules[name];
    },
    addIoWaiter() {}, messagePortRefs: 0,
  });
  return { implementation, channels, stop };
}

test("worker parent reads the channel descriptors the spawn call bound for it", () => {
  const { implementation, channels, stop } = workerModule(false);
  expect(() => new implementation.Worker("", { eval: true })).toThrow(stop);
  expect(channels).toEqual([[21, 22]]);
});

test("worker self reads the descriptors its parent published in the environment", () => {
  const { implementation, channels, stop } = workerModule(true);
  expect(() => implementation.initialize()).toThrow(stop);
  expect(channels).toEqual([[12, 15]]);
});

for (const control of [null, { input: 12 }, { input: 1, output: 15 }, { input: 12, output: 2 }, { input: "12", output: 15 }]) {
  test(`worker self rejects control descriptors ${JSON.stringify(control)}`, () => {
    const { implementation, channels } = workerModule(true, control);
    expect(() => implementation.initialize()).toThrow("Invalid worker control descriptors");
    expect(channels).toEqual([]);
  });
}
