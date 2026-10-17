import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.workerFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/worker_threads.ts", import.meta.url), "utf8")}`);

function workerModule(self: boolean) {
  const calls: number[][] = [];
  const channels: number[][] = [];
  const stop = new Error("channel opened");
  const factory = runInNewContext(source, {
    EventTarget, Event, MessageEvent, DOMException, URL, structuredClone,
  });
  const process = {
    env: self ? { BUNWASM_WORKER_INIT: JSON.stringify({
      route: [1], envGroup: "worker", argv: ["bun", "[worker eval]"], execArgv: [], graph: {},
    }) } : {},
    execArgv: [], execPath: "bun", cwd: () => "/",
  };
  const modules: Record<string, unknown> = {
    process, events: EventEmitter, structured_clone: { structuredClone }, net: {},
    worker_codec: { create: () => ({ prepare: () => ({ graph: {}, commit() {} }) }) },
    spawn: { spawn: () => ({ pid: 71, _abortWorker() {} }) },
    worker_channel: { open: (read: number, write: number) => {
      channels.push([read, write]);
      throw stop;
    } },
  };
  const implementation = factory({
    realTimers: { setImmediate() {} },
    native: { hostChildPipe: (pid: number, selector: number) => {
      calls.push([pid, selector]);
      return selector + 100;
    } },
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
      return modules[name];
    },
    addIoWaiter() {}, messagePortRefs: 0,
  });
  return { implementation, calls, channels, stop };
}

test("worker parent reads selector 5 and writes selector 4 without reading final-signal metadata", () => {
  const { implementation, calls, channels, stop } = workerModule(false);
  expect(() => new implementation.Worker("", { eval: true })).toThrow(stop);
  expect(calls).toEqual([[71, 5], [71, 4]]);
  expect(channels).toEqual([[105, 104]]);
});

test("worker self reads selector 4 and writes selector 5 without reading final-signal metadata", () => {
  const { implementation, calls, channels, stop } = workerModule(true);
  expect(() => implementation.initialize()).toThrow(stop);
  expect(calls).toEqual([[0, 4], [0, 5]]);
  expect(channels).toEqual([[104, 105]]);
});
