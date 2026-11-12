import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { analyzeChrome, chromeContext, chromeControl, chromeProfiles, geckoControl, analyzeGecko } from "./lifecycle-profile-analysis";
import { array, object } from "./input";
import { splitProfile } from "./profile";
import { collectorConfiguration, validateProfileControl } from "./lifecycle-profile-config";
import { chromeRetention } from "./lifecycle-profile-retention";

const window = { before: 100, after: 110 };
const telemetry = { tracingComplete: { dataLossOccurred: false }, streamReadComplete: true, bufferUsage: [{ at: 1, event: { percentFull: 0.2 } }] };
function saved(name: string) {
  const value = object(JSON.parse(readFileSync(new URL(`../../tests/performance/fixtures/${name}.json`, import.meta.url), "utf8")));
  if (name === "lifecycle-chrome-window") value.metadata = { trace_processor_stats: { traced_buf: [{ chunks_discarded: 0, bytes_overwritten: 0 }] } };
  return value;
}
test("Chrome saved exhausted buffers fail closed even when marker calls and completion succeed", () => {
  const input = saved("lifecycle-chrome-window");
  input.metadata = saved("lifecycle-chrome-retention").metadata;
  expect(chromeRetention(input, telemetry).available).toBe(false);
  expect(chromeRetention(input, telemetry).loss[0]?.value).toBe(9322);
  expect(chromeControl(input, input.targets, "browser", window, { begin: "command-begin", end: "command-end" }, telemetry).available).toBe(false);
  expect(chromeRetention(saved("lifecycle-chrome-window"), undefined).available).toBe(false);
  expect(chromeRetention(saved("lifecycle-chrome-window"), { ...telemetry, tracingComplete: { dataLossOccurred: true } }).available).toBe(false);
  expect(chromeRetention(saved("lifecycle-chrome-window"), { ...telemetry, bufferUsage: [] }).available).toBe(false);
  expect(chromeRetention(saved("lifecycle-chrome-window"), { ...telemetry, streamReadComplete: false }).available).toBe(false);
});
test("Chrome performance marks bind command and worker identities without timeline events", () => {
  const input = saved("lifecycle-chrome-window");
  input.traceEvents = array(input.traceEvents).map(object).map(event => event.name !== "TimeStamp" ? event : {
    ...event, cat: "blink.user_timing", ph: "I", name: object(object(event.args).data).message, args: { data: { startTime: 12 } },
  });
  expect(chromeControl(input, input.targets, "browser", window, { begin: "command-begin", end: "command-end" }, telemetry).available).toBe(true);
  expect(chromeProfiles(input, chromeContext(input.markers, window, input.targets, telemetry))[1]?.sampleTimesUs).toEqual([1000, 1001, 1039, 1040]);
  const events = array(input.traceEvents).map(object);
  input.traceEvents = events.filter(event => event.name !== "command-end");
  expect(chromeControl(input, input.targets, "browser", window, { begin: "command-begin", end: "command-end" }, telemetry).available).toBe(false);
});
test("Chrome source-only Internal chunk is metadata with zero samples, malformed and incomplete profiles still fail", () => {
  const input = saved("lifecycle-chrome-window"), events = array(input.traceEvents);
  const metadata = saved("lifecycle-chrome-retention").sourceOnly;
  input.traceEvents = events.concat([metadata]);
  expect(chromeProfiles(input).map(row => row.selection.captureSamples)).toEqual([2, 6, 2]);
  input.traceEvents = [metadata];
  expect(() => chromeProfiles(input)).toThrow("empty");
  const bad = structuredClone(object(metadata));
  object(bad.args).data = { source: "Internal", timeDeltas: [1] };
  input.traceEvents = events.concat([bad]);
  expect(() => chromeProfiles(input)).toThrow("source-only");
  object(bad.args).data = { source: 12 };
  expect(() => chromeProfiles(input)).toThrow();
  input.traceEvents = events.filter(event => object(event).name !== "Profile");
  expect(() => chromeProfiles(input)).toThrow();
});
test("Chrome signed sample timestamps clip exact trace boundaries and bind reused tids to distinct temporal workers", () => {
  const input = saved("lifecycle-chrome-window"), markers = { begin: "command-begin", end: "command-end" };
  const context = chromeContext(markers, window, input.targets, telemetry);
  const rows = chromeProfiles(input, context);
  expect(rows.map(row => row.tid)).toEqual([11, 11, 12]);
  expect(rows[1]?.sampleTimesUs).toEqual([1000, 1001, 1039, 1040]);
  expect(rows[1]?.worker?.workerId).toBe("new");
  expect(rows[1]?.selection.excludedSamples).toBe(2);
  expect(analyzeChrome(input, "browser", "control", context).map(row => row.analysis.samples)).toEqual([4, 2]);
  expect(chromeControl(input, input.targets, "browser", window, markers, telemetry).available).toBe(true);
  expect(chromeControl(input, input.targets, "quickjs", window, markers, telemetry).available).toBe(false);
  expect(chromeProfiles(input)[1]?.sampleTimesUs).toEqual([999, 1000, 1001, 1039, 1040, 1041]);
});
test("Chrome old captures retain wider scope and cannot certify exact workload controls without a clock join", () => {
  const input = saved("lifecycle-chrome-window");
  expect(chromeControl(input, input.targets, "browser", window).available).toBe(false);
  const rows = analyzeChrome(input, "browser", "next");
  expect(rows[1]?.workloadWindow.available).toBe(false);
  expect(rows[1]?.worker).toBeNull();
  expect(rows[1]?.analysis.scope).toContain("wider capture");
  expect(rows[1]?.analysis.samples).toBe(6);
  const missing = chromeContext({ begin: "missing", end: "command-end" }, window, input.targets);
  expect(analyzeChrome(input, "browser", "next", missing)[1]?.workloadWindow.available).toBe(false);
});
test("Chrome mismatched lifetimes and ambiguous temporal markers remain unmapped", () => {
  const input = saved("lifecycle-chrome-window"), markers = { begin: "command-begin", end: "command-end" };
  const targets = array(input.targets).map(object);
  const exit = targets.find(row => row.id === "new" && row.event === "exited")!;
  exit.at = 101;
  expect(chromeProfiles(input, chromeContext(markers, window, targets, telemetry))[1]?.worker).toBeNull();
  expect(chromeControl(input, targets, "browser", window, markers, telemetry).available).toBe(false);
  const events = array(input.traceEvents).map(object);
  events.push({ name: "TimeStamp", pid: 1, tid: 11, ts: 1020, args: { data: { message: "lifecycle-profile-target:another" } } });
  input.traceEvents = events;
  expect(chromeProfiles(input, chromeContext(markers, window, input.targets, telemetry))[1]?.worker).toBeNull();
  events.push({ name: "ProfileChunk", pid: 1, tid: 999, id: "new", args: { data: { cpuProfile: { samples: [2] }, timeDeltas: [] } } });
  expect(() => chromeProfiles(input)).toThrow("coverage");
});

test("Gecko saved samples intersect registration lifetime and duplicate identities cannot certify two workers", () => {
  const input = saved("lifecycle-gecko-lifetime");
  expect(analyzeGecko(input, window)[0]?.samples).toBe(4);
  expect(analyzeGecko(input, window)[0]?.observedWindowEpochMs).toEqual({ first: 101, last: 109 });
  const thread = object(array(input.threads)[0]);
  input.threads = [thread, structuredClone(thread)];
  expect(() => geckoControl(input, window, "browser")).toThrow("Duplicate");
  input.threads = [thread];
  thread.unregisterTime = 0;
  expect(() => analyzeGecko(input, window)).toThrow("Contradictory");
});
test("offline CLI uses recorded trace bounds and reads compressed-only saved input", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-profile-cli-"));
  try {
    const input = saved("lifecycle-chrome-window");
    writeFileSync(join(directory, "chrome-trace.json.gz"), gzipSync(JSON.stringify(input)));
    writeFileSync(join(directory, "chrome-targets.json"), JSON.stringify(input.targets));
    writeFileSync(join(directory, "chrome-retention.json"), JSON.stringify(telemetry));
    writeFileSync(join(directory, "run.json"), JSON.stringify({ configuration: { browser: "chrome", engine: "browser", phase: "control" }, window, chromeWindowMarkers: input.markers }));
    const child = spawnSync(process.execPath, [new URL("./lifecycle-profile-analysis.ts", import.meta.url).pathname, directory], { encoding: "utf8" });
    expect(child.status).toBe(0);
    const result = object(JSON.parse(readFileSync(join(directory, "reanalysis.json"), "utf8")));
    expect(object(object(result.observation).profile).available).toBe(true);
    expect(array(result.rows).map(row => object(object(row).analysis).samples)).toEqual([4, 2]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
  expect(rows[0]?.retention.firstSampleLagMs).toBe(4);
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

function controlContext() {
  return { sourceHead: "committed-source", hostIdentity: "frozen-host", profile: "split",
    browser: { executable: "/chrome", browserVersion: "157", headless: true }, collector: collectorConfiguration("chrome") };
}
function passedControl() {
  return { configuration: { browser: "chrome", engine: "quickjs", phase: "control" }, collectorContext: controlContext(),
    workloadFailure: null, observerFailure: null, chromeWindowMarkers: { begin: "unique-begin", end: "unique-end" },
    observation: { profile: { available: true, retention: { available: true }, workloadWindow: {
      available: true, source: { begin: "unique-begin", end: "unique-end" },
    } } } };
}
test("collector fixes narrow record-until-full capacity and requires the same exact control context", () => {
  const expected = { browser: "chrome", engine: "quickjs" };
  const config = collectorConfiguration("chrome");
  expect(config).toMatchObject({ traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: 524288,
    includedCategories: ["disabled-by-default-v8.cpu_profiler", "blink.user_timing"], excludedCategories: ["*"] } });
  expect(() => validateProfileControl(passedControl(), expected, controlContext())).not.toThrow();
  for (const context of [
    { ...controlContext(), collector: { traceConfig: { traceBufferSizeInKb: 204800 } } },
    { ...controlContext(), collector: { ...config, bufferUsageReportingInterval: 2000 } },
    { ...controlContext(), sourceHead: "different-source" },
    { ...controlContext(), hostIdentity: "other-host" },
    { ...controlContext(), browser: { ...controlContext().browser, browserVersion: "158" } },
    { ...controlContext(), browser: { ...controlContext().browser, executable: "/other-chrome" } },
    { ...controlContext(), browser: { ...controlContext().browser, headless: false } },
  ]) expect(() => validateProfileControl(passedControl(), expected, context)).toThrow("context differs");
  const legacy = { ...passedControl(), collectorContext: undefined };
  expect(() => validateProfileControl(legacy, expected, controlContext())).toThrow();
  expect(() => validateProfileControl(passedControl(), { ...expected, engine: "jsc" }, controlContext())).toThrow();
  const failed = passedControl();
  failed.observation.profile.retention.available = false;
  expect(() => validateProfileControl(failed, expected, controlContext())).toThrow("retention");
  const mismatched = passedControl();
  mismatched.chromeWindowMarkers.end = "other-end";
  expect(() => validateProfileControl(mismatched, expected, controlContext())).toThrow("boundaries");
});
