import { expect, test } from "bun:test";
import { analyzeChrome, chromeControl, chromeProfiles, geckoControl, analyzeGecko } from "./lifecycle-profile-analysis";
import { splitProfile } from "./profile";

function chromeWorker(id: string, tid: number, target: string, name: string) {
  return [
    { name: "Profile", pid: 1, tid, id, args: { data: { startTime: 10 } } },
    { name: "ProfileChunk", pid: 1, tid: 999, id, args: { data: { cpuProfile: { nodes: [
      { id: 1, callFrame: { functionName: "(root)" } },
      { id: 2, parent: 1, callFrame: { functionName: name, url: "guest.ts" } },
    ], samples: [2, 2] }, timeDeltas: [12, -1] } } },
    { name: "TimeStamp", pid: 1, tid, args: { data: { message: "lifecycle-profile-target:" + target } } },
  ];
}
const targets = [
  { event: "born", type: "worker", id: "root", at: 101 }, { event: "exited", id: "root", at: 108 },
  { event: "born", type: "worker", id: "child", at: 103 }, { event: "exited", id: "child", at: 107 },
];
const window = { before: 100, after: 110 };
test("Chrome chunks join by process/profile id rather than sampler thread; signed deltas do not weight samples", () => {
  const input = { traceEvents: chromeWorker("a", 11, "root", "lifecycleProfileRoot").concat(chromeWorker("b", 12, "child", "lifecycleProfileChild")) };
  const rows = chromeProfiles(input);
  expect(rows.map(row => row.tid)).toEqual([11, 12]);
  expect(analyzeChrome(input, "browser", "control")[0]?.analysis.samples).toBe(2);
  expect(chromeControl(input, targets, "browser", window).available).toBe(true);
  expect(chromeControl(input, targets.filter(row => row.id !== "child" || row.event !== "exited"), "browser", window).available).toBe(false);
  expect(chromeControl(input, targets, "quickjs", window).available).toBe(false);
});
test("unmapped Chrome worker samples cannot pass coverage, and malformed samples fail closed", () => {
  const events: unknown[] = chromeWorker("a", 11, "root", "lifecycleProfileRoot");
  expect(chromeControl({ traceEvents: chromeWorker("a", 11, "root", "lifecycleProfileRoot").filter(row => row.name !== "TimeStamp") }, targets, "browser", window).available).toBe(false);
  events.push({ name: "ProfileChunk", pid: 1, tid: 500, id: "a", args: { data: { cpuProfile: { samples: [2] }, timeDeltas: [] } } });
  expect(() => chromeProfiles({ traceEvents: events })).toThrow("coverage");
});

function geckoThread(tid: number, child = false) {
  return { name: "DOM Worker", pid: 1, tid, registerTime: 1, unregisterTime: 9,
    stringTable: ["", "lifecycleProfileRoot", "lifecycleProfileChild", "0x123"],
    samples: { schema: { stack: 0, time: 1 }, data: [[child ? 1 : 0, 5], [2, 6], [null, 7], [0, 99]] },
    stackTable: { schema: { prefix: 0, frame: 1 }, data: [[null, 0], [0, 1], [null, 2]] },
    frameTable: { schema: { location: 0 }, data: [[1], [2], [3]] } };
}
test("Gecko retains exited root and child computation, excludes out-of-window samples and counts unknown leaves", () => {
  const input = { meta: { startTime: 100 }, threads: [geckoThread(1), geckoThread(2, true)], processes: [] };
  const rows = analyzeGecko(input, window);
  expect(rows[0]?.samples).toBe(3);
  expect(rows[0]?.unknownLeafSamples).toBe(2);
  expect(rows[1]?.childComputation).toBe(1);
  expect(geckoControl(input, window, "browser").available).toBe(true);
  input.threads[1]!.unregisterTime = 19;
  expect(geckoControl(input, window, "browser").available).toBe(false);
});
test("Gecko process origins are honored and cyclic stacks are rejected", () => {
  const thread = geckoThread(1);
  const input = { meta: { startTime: 0 }, threads: [], processes: [{ meta: { startTime: 100 }, threads: [thread] }] };
  expect(analyzeGecko(input, window)[0]?.samples).toBe(3);
  thread.stackTable.data[0] = [0, 0];
  expect(() => analyzeGecko(input, window)).toThrow("Cyclic");
});
test("profile context preserves sample union semantics and counts stripped Wasm as unknown", () => {
  const profile = { startTime: 1, endTime: 100, nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
    { id: 2, callFrame: { functionName: "js::Interpret", url: "wasm://engine" }, children: [3] },
    { id: 3, callFrame: { functionName: "wasm-to-js", url: "" }, children: [4] },
    { id: 4, callFrame: { functionName: "wasm-function[12]", url: "wasm://core" }, children: [] },
  ], samples: [2, 3, 4] };
  const result = splitProfile(profile, { configuration: "test-engine", scope: "test worker" });
  expect(result.configuration).toBe("test-engine");
  expect(result.strippedWasmSelfSamples).toBe(1);
  expect(result.unknownSelfSamples).toBe(1);
  expect(result.detourInclusivePercent).toBeCloseTo(200 / 3);
  expect(result.detourOverheadPercent).toBeCloseTo(100 / 3);
});
