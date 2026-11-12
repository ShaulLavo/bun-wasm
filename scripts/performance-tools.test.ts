import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { capture, checkResult } from "./performance/capture";
import { array, canonical, identity, json, number, object, parsePlan, sha256, treeInventory } from "./performance/input";
import { splitProfile } from "./performance/profile";
import { replay } from "./performance/replay";

const root = resolve(import.meta.dir, "..");
const fixtures = join(root, "tests/performance/fixtures");

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20000 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stderr}`);
  return result.stdout;
}

test("the tools package's default Cargo binaries contain only the WASI guest", () => {
  const manifest = object(JSON.parse(run("rustup", ["run", "stable", "cargo", "read-manifest", "--manifest-path", join(root, "crates/bunwasm-tools/Cargo.toml")])));
  const binaries = array(manifest.targets).map(object).filter(target => array(target.kind).includes("bin")).map(target => target.name);
  expect(binaries).toEqual(["bun-tools"]);
}, 20000);

test("saved profile counts sample entries, separates useful callees, and rejects missing captures", () => {
  const frame = (id: number, name: string, url: string, children: number[]) => ({ id, callFrame: { functionName: name, url }, children, hitCount: 9999 });
  const profile = { startTime: 0, endTime: 1000000, nodes: [
    frame(1, "(root)", "", [2]), frame(2, "engine", "wasm://engine", [3, 6]),
    frame(3, "observer", "host.ts", [4]), frame(4, "malloc", "wasm://core", [5]),
    frame(5, "readlink", "fs.ts", []), frame(6, "clock", "host.ts", []),
  ], samples: [2, 3, 4, 5, 6] };
  const split = splitProfile(profile);
  expect(split.samples).toBe(5);
  expect(split.detourInclusivePercent).toBe(60);
  expect(split.detourOverheadPercent).toBe(20);
  expect(split.hostInclusivePercent).toBe(40);
  expect(split.detours[0]?.reentries).toEqual([{ callee: "wasm://core malloc", samples: 2 }]);
  expect(() => splitProfile({ ...profile, samples: [] })).toThrow("missing/empty");
  expect(() => splitProfile({ ...profile, samples: [88] })).toThrow("unknown sample");
  expect(() => splitProfile({ ...profile, nodes: profile.nodes.concat([frame(7, "lost", "", [])]) })).toThrow("one tree root");
});

test("frozen engine input verifies complete lists, warning/count drift, missing callbacks and stubs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-perf-fixture-"));
  try {
    const harness = join(fixtures, "nft-replay.cjs"), fixture = join(fixtures, "replay-small.json");
    const stdout = run(process.execPath, [harness, "replay", fixture]);
    const result = object(JSON.parse(stdout.trim().replace("BUN_WASM_PERF_RESULT ", "")));
    expect(result.fileList).toEqual(["entry.js"]);
    expect(result.counts).toEqual({ readFile: 1, readStringLength: 3, readlink: 1, stat: 1, ignore: 1 });
    checkResult(result, "replay");
    expect(() => checkResult({ ...result, stubUse: { fs: 1 } }, "replay")).toThrow("stub");
    const changed = object(json(fixture));
    changed.readFile = {};
    const missing = join(scratch, "missing.json"); writeFileSync(missing, JSON.stringify(changed));
    expect(spawnSync(process.execPath, [harness, "replay", missing]).status).not.toBe(0);
    const drift = object(json(fixture)); object(drift.expected).warnings = 1;
    const warnings = join(scratch, "warnings.json"); writeFileSync(warnings, JSON.stringify(drift));
    expect(spawnSync(process.execPath, [harness, "replay", warnings]).status).not.toBe(0);
    const stubs = object(json(fixture)); stubs.stubUse = { child_process: 1 };
    const stubbed = join(scratch, "stubs.json"); writeFileSync(stubbed, JSON.stringify(stubs));
    expect(spawnSync(process.execPath, [harness, "replay", stubbed]).status).not.toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("load-only replay rejects caught module-initialization stubs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-perf-load-"));
  try {
    const harness = join(fixtures, "nft-replay.cjs"), fixture = join(fixtures, "replay-small.json");
    const stdout = run(process.execPath, [harness, "load", fixture]);
    const result = object(JSON.parse(stdout.trim().replace("BUN_WASM_PERF_RESULT ", "")));
    checkResult(result, "load");
    const changed = object(json(fixture));
    const module = object(object(changed.modules)["next/dist/compiled/@vercel/nft"]);
    module.source = "try { require('child_process').execSync('unused'); } catch {}\n" + module.source;
    const stubbed = join(scratch, "caught-stub.json");
    writeFileSync(stubbed, JSON.stringify(changed));
    const rejected = spawnSync(process.execPath, [harness, "load", stubbed], { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("unexpected stub use");
    expect(result.stubUse).toEqual({});
    expect(() => checkResult({ ...result, stubUse: { child_process: 1 } }, "load")).toThrow("stub");
    const missing = { ...result };
    delete missing.stubUse;
    expect(() => checkResult(missing, "load")).toThrow();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("Linux counter covers orphan work, fails closed and cleans descendants; runner rotates matched warm pairs", async () => {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return;
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-perf-tools-test-"));
  try {
    const counter = join(scratch, "counter"), child = join(scratch, "child"), unit = join(scratch, "unit");
    const source = join(root, "crates/bunwasm-tools/src/bin/instruction-count.rs");
    run("rustup", ["run", "stable", "rustc", "--edition", "2024", "-O", "-D", "warnings", source, "-o", counter]);
    run("rustup", ["run", "stable", "rustc", "--edition", "2024", "--test", "-D", "warnings", source, "-o", unit]);
    run(unit, []);
    run("rustup", ["run", "stable", "rustc", "--edition", "2024", "-O", "-D", "warnings", join(fixtures, "counter-child.rs"), "-o", child]);
    const allowed = /Cpus_allowed_list:\s*(\d+)/.exec(readFileSync("/proc/self/status", "utf8"));
    const cpu = Number(allowed?.[1] ?? "0");
    let ordinal = 0;
    const count = (args: string[], seconds = 3) => {
      const path = join(scratch, `counter-${ordinal++}.json`);
      const result = spawnSync("/usr/bin/taskset", ["-c", String(cpu), counter, path, String(seconds)].concat(args), { encoding: "utf8", timeout: 10000 });
      return { ...result, record: object(json(path)) };
    };
    const availability = count(["/usr/bin/true"]);
    if (availability.status !== 0) {
      expect(availability.record.valid).toBe(false);
      expect(String(availability.record.error)).toContain("perf_event_open");
      console.error(`Hardware capture unavailable; fail-closed path verified: ${availability.record.error}`);
      return;
    }
    const direct = count([child, "spin", "10000000"]);
    const orphan = count([child, "orphan-spin", "10000000"]);
    expect(orphan.status).toBe(0);
    expect(number(orphan.record.reapedProcesses)).toBeGreaterThanOrEqual(2);
    expect(number(orphan.record.instructions)).toBeGreaterThan(number(direct.record.instructions) * 0.9);
    const threads = count([child, "threads", "10000000"]);
    expect(threads.status).toBe(0);
    expect(number(threads.record.instructions)).toBeGreaterThan(number(direct.record.instructions) * 1.8);
    const failed = count(["/bin/sh", "-c", "exit 7"]);
    expect(failed.status).toBe(7); expect(failed.record.exit).toBe(7);
    const pidFile = join(scratch, "orphan.pid");
    const timed = count([child, "orphan-wait", pidFile], 0.2);
    expect(timed.status).not.toBe(0); expect(timed.record.valid).toBe(false);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    await checkSignal(counter, child, cpu, scratch);
    await checkRunner(counter, cpu, scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 60000);

async function checkSignal(counter: string, child: string, cpu: number, scratch: string) {
  const pidFile = join(scratch, "signal.pid"), output = join(scratch, "signal.json");
  const processTree = spawn("/usr/bin/taskset", ["-c", String(cpu), counter, output, "5", child, "orphan-wait", pidFile]);
  const closed = new Promise<number | null>(resolve => processTree.once("close", resolve));
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(pidFile)).toBe(true);
    processTree.kill("SIGTERM");
    expect(await closed).not.toBe(0);
    expect(object(json(output)).valid).toBe(false);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  } finally { processTree.kill("SIGTERM"); await closed; }
}

async function checkRunner(counter: string, cpu: number, scratch: string) {
  const harness = join(fixtures, "nft-replay.cjs"), fixture = join(fixtures, "replay-small.json");
  const cache = join(scratch, "cache"); mkdirSync(cache);
  const source = join(root, "crates/bunwasm-tools/src/instruction_count.rs");
  const flags = join(scratch, "flags.txt"); writeFileSync(flags, "tool-test, no product tier\n");
  const plan = { workload: "frozen-small-fixture", arm: "before", configuration: "tool-test", mode: "replay", sourceRevision: "test-source", observer: "none",
    counter, cpu, timeoutSeconds: 3, cwd: root, env: { PATH: process.env.PATH! }, cacheRoots: [cache],
    command: [process.execPath, harness, "{mode}", fixture], control: { mode: "control", value: 704982704 },
    inputs: [[harness, "fixture"], [fixture, "fixture"], [source, "source"], [flags, "flags"], [counter, "counter"], [process.execPath, "executable"]].map(([path, role]) => ({ path, role, kind: "file", sha256: identity(path!, "file") })) };
  const before = join(scratch, "before.json"), after = join(scratch, "after.json");
  writeFileSync(before, JSON.stringify(plan)); writeFileSync(after, JSON.stringify({ ...plan, arm: "after" }));
  const first = await capture(parsePlan(before), join(scratch, "oracle"), null, "warmup");
  const oracle = join(scratch, "oracle/result.json");
  await replay(before, after, oracle, join(scratch, "pairs"));
  const runs = object(json(join(scratch, "pairs/summary.json")));
  expect(runs.schedule).toEqual(["before", "after", "before", "after", "after", "before"]);
  expect(sha256(canonical(json(oracle)))).toBe(first.resultSha256);
  const wrong = { ...object(json(oracle)), fileList: ["wrong.js"] };
  await expect(capture(parsePlan(before), join(scratch, "drift"), wrong, "warm")).rejects.toThrow("equality");
  const changed = { ...plan, inputs: plan.inputs.map(input => ({ ...input, sha256: "0".repeat(64) })) };
  const bad = join(scratch, "changed.json"); writeFileSync(bad, JSON.stringify(changed));
  await expect(capture(parsePlan(bad), join(scratch, "changed"), null, "warm")).rejects.toThrow("input changed");
  expect(treeInventory(cache)).toEqual([]);
}
