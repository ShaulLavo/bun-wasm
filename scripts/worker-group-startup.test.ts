import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker as Thread } from "node:worker_threads";
import { CHILD_STAGE, groupRuntime, sendFrame, STAGE_WAITING } from "./fixtures/shared-objects/group-runtime";

// The host starts a worker's thread inside spawn, before the parent can route the startup pins
// to the returned pid. Here the child runs first (the worst order) on a real thread: it must
// block for the parent's publication rather than accept a pin the parent still owns.
test("a group worker decodes its startup buffers only after the parent routes their pins", async () => {
  const words = new Int32Array(new SharedArrayBuffer(4096));
  const region = new SharedArrayBuffer(16);
  new Int32Array(region)[0] = 42;
  const child = new Thread(new URL("./fixtures/shared-objects/group-startup-child.ts", import.meta.url), { workerData: { words: words.buffer, region } });
  try {
    expect((await once(child, "message"))[0]).toBe("ready");
    let stageAtSpawn = -1;
    const parentChannel = { send: (frame: unknown) => sendFrame(words, frame), drain() {}, pump: () => false,
      subscriptions: () => new Uint8Array(), close() {}, pending: false, ended: false, waitReadable() {} };
    const parent = groupRuntime({ group: { words, region }, pid: 1, parentChannel, spawn(_argv, options) {
      child.postMessage({ env: { ...options.env, BUNWASM_WORKER_CONTROL: '{"input":12,"output":15}' } });
      Atomics.wait(words, CHILD_STAGE, 0, 10_000); // until the child accepts or blocks
      stageAtSpawn = Atomics.load(words, CHILD_STAGE);
      return { pid: 2, _workerChannel: { input: 3, output: 4 }, stdout: null, stderr: null, stdin: null,
        exited: new Promise(() => {}), ref() {}, unref() {}, kill() { return true; }, _abortWorker() {} };
    } });
    new parent.Worker("", { eval: true, workerData: { sab: region } });
    const [result] = await once(child, "message");
    expect({ stageAtSpawn, result }).toEqual({ stageAtSpawn: STAGE_WAITING, result: { value: 42, owner: 0 } });
  } finally {
    await child.terminate();
  }
});

test("a group worker whose parent closes before publishing fails instead of waiting", () => {
  const words = new Int32Array(new SharedArrayBuffer(4096));
  const init = { route: [1], envGroup: "group", argv: ["bun", "[worker eval]"], execArgv: [], graph: { root: 0, nodes: [["undefined"]] }, attach: true };
  const closed = { send() {}, drain() {}, pump: () => false, subscriptions: () => new Uint8Array(), close() {}, pending: false, ended: true,
    waitReadable() { throw new Error("waited on a closed parent"); } };
  const threads = groupRuntime({ group: { words, region: new SharedArrayBuffer(4) }, pid: 2, parentChannel: closed,
    env: { BUNWASM_WORKER_INIT: JSON.stringify(init), BUNWASM_WORKER_CONTROL: '{"input":12,"output":15}' } });
  expect(() => threads.initialize()).toThrow("Worker parent closed before publishing its shared memory");
});
