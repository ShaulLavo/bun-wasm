import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker as Thread } from "node:worker_threads";
import { allocate, CHILD_STAGE, closeFd, createGroup, groupRuntime, LANE_BYTES, pipeFds, share, STAGE_WAITING } from "./fixtures/shared-objects/group-runtime";

// The host starts a worker's thread inside spawn, before the parent can route the startup pins
// to the returned pid. Here the child runs first (the worst order) on a real thread: it must
// block for the parent's publication rather than accept a pin the parent still owns.
// BUN_WASM_LANE_SOURCES=<older tree> runs that tree's runtime (red control at 008f63ae).
const sources = process.env.BUN_WASM_LANE_SOURCES;
test("a group worker decodes its startup buffers only after the parent routes their pins", async () => {
  const group = createGroup([16, LANE_BYTES], 1 << 16);
  const region = allocate(group, 16);
  new Int32Array(region)[0] = 42;
  const child = new Thread(new URL("./fixtures/shared-objects/group-startup-child.ts", import.meta.url), { workerData: { group: share(group), sources } });
  try {
    expect((await once(child, "message"))[0]).toBe("ready");
    let stageAtSpawn = -1;
    const parent = groupRuntime({ group, pid: 1, sources, spawn(spec) {
      child.postMessage(spec);
      Atomics.wait(group.words, CHILD_STAGE, 0, 10_000); // until the child accepts or blocks
      stageAtSpawn = Atomics.load(group.words, CHILD_STAGE);
      return { exited: new Promise(() => {}), kill() {} };
    } });
    new parent.threads.Worker("", { eval: true, workerData: { sab: region } });
    const [result] = await once(child, "message");
    parent.loop.stop();
    expect({ stageAtSpawn, result }).toEqual({ stageAtSpawn: STAGE_WAITING, result: { value: 42, pins: 0 } });
  } finally {
    await child.terminate();
  }
});

test("a group worker whose parent closes before publishing fails instead of waiting", () => {
  const group = createGroup([], 1 << 16);
  const toChild = pipeFds(0), toParent = pipeFds(1);
  closeFd(group, toChild.write);
  const init = { route: [1], envGroup: "group", argv: ["bun", "[worker eval]"], execArgv: [], graph: { root: 0, nodes: [["undefined"]] }, attach: true, parent: 1 };
  const member = groupRuntime({ group, pid: 2,
    env: { BUNWASM_WORKER_INIT: JSON.stringify(init), BUNWASM_WORKER_CONTROL: JSON.stringify({ input: toChild.read, output: toParent.write }) } });
  try { expect(() => member.threads.initialize()).toThrow("Worker parent closed before publishing its shared memory"); }
  finally { member.loop.stop(); }
});
