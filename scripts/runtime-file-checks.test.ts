import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dispatchRuntime, runtimeJobs, runtimePlan } from "./runtime-file-checks.ts";
import { discoverChecks, parseCheck, selectChecks } from "./test-checks.ts";
import { linuxProcess } from "./process-owner.mts";
import { runSubreaperProbe } from "./test-subreaper-command.ts";
import { needsJsc, needsRust } from "./ci-changes.ts";

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("runtime concurrency is explicit and bounded", () => {
  expect(runtimeJobs("1")).toBe(1);
  expect(runtimeJobs("2")).toBe(2);
  for (const value of ["", "0", "3", "2.0", "Infinity", "-1"]) expect(() => runtimeJobs(value)).toThrow("Invalid BUN_WASM_RUNTIME_JOBS");
});

test("runtime scheduling source changes select the real native producers", () => {
  for (const path of ["scripts/runtime-file-checks.ts", "scripts/run-with-timeout.mts", "scripts/process-owner.mts", "scripts/linux-subreaper.mts"]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(true);
  }
  expect(needsRust(["docs/bun-patches/runtime-file-scheduling.md"])).toBe(false);
});

test("only audited runtime files opt into process isolation", () => {
  const checks = discoverChecks();
  const paths = selectChecks("runtime", checks);
  const plan = runtimePlan(paths, checks);
  expect(plan.isolated).toEqual([
    "scripts/jsc-json-fast-controls.test.ts",
    "scripts/spidermonkey-module-evaluation-info.test.ts", "scripts/wasm-tables.test.ts",
  ]);
  expect(plan.serial).toContain("scripts/spidermonkey-ordinary-fixtures.test.ts");
  expect(plan.serial).toContain("scripts/spidermonkey-loop-controls.test.ts");
  expect(plan.serial.concat(plan.isolated).sort()).toEqual(paths);
  expect(() => runtimePlan(paths.concat([paths[0]!]), checks)).toThrow("selection");
  expect(() => runtimePlan(["scripts/ci-quality.test.ts"], checks)).toThrow("selection");
  const path = "scripts/example.test.ts";
  for (const owner of ["web", "quality", "native-probe"]) expect(() => parseCheck({ owner, path, isolation: "process" }, `${owner}-example.json`)).toThrow("isolation");
  for (const isolation of [true, null, "file", 2]) expect(() => parseCheck({ owner: "runtime", path, isolation }, "runtime-example.json")).toThrow("isolation");
  expect(runtimePlan([path], [parseCheck({ owner: "runtime", path }, "runtime-example.json")])).toEqual({ serial: [path], isolated: [] });
});

test("dispatch runs the serial barrier and every isolated file once, at most two at a time", async () => {
  const calls: string[][] = [];
  let active = 0;
  let peak = 0;
  const plan = { serial: ["serial-a", "serial-b"], isolated: ["a", "b", "c", "d"] };
  expect(await dispatchRuntime(plan, async paths => {
    calls.push(paths.slice());
    peak = Math.max(peak, ++active);
    await delay(0);
    active--;
    return 0;
  })).toBe(0);
  expect(calls[0]).toEqual(plan.serial);
  expect(calls.flat()).toEqual(plan.serial.concat(plan.isolated));
  expect(peak).toBe(2);
});

test("failure stops pending dispatch, preserves status and waits for the active sibling", async () => {
  const calls: string[] = [];
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let drained = false;
  const result = dispatchRuntime({ serial: [], isolated: ["failure", "active", "pending"] }, async paths => {
    calls.push(...paths);
    if (paths[0] === "failure") return 7;
    await pending;
    drained = true;
    return 0;
  });
  await delay(0);
  expect(calls).toEqual(["failure", "active"]);
  expect(drained).toBe(false);
  release();
  expect(await result).toBe(7);
  expect(drained).toBe(true);
  const serialCalls: string[][] = [];
  expect(await dispatchRuntime({ serial: ["failure"], isolated: ["pending"] }, async paths => { serialCalls.push(paths.slice()); return 9; })).toBe(9);
  expect(serialCalls).toEqual([["failure"]]);
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-runtime-dispatch-"));
  owned.push(root);
  for (const name of ["scripts", "checks", "tmp", "events"]) mkdirSync(join(root, name));
  for (const name of ["test-checks.ts", "runtime-file-checks.ts", "run-with-timeout.mts", "process-owner.mts", "linux-subreaper.mts"]) copyFileSync(join(import.meta.dir, name), join(root, "scripts", name));
  writeFileSync(join(root, "scripts/value.ts"), 'export const value = "original";');
  for (const name of ["serial", "a", "b", "c", "d"]) addFile(root, name);
  writeFileSync(join(root, "scripts/undiscovered.test.ts"), 'throw new Error("An unregistered test ran");');
  return root;
}

function addFile(root: string, name: string): void {
  writeFileSync(join(root, `checks/runtime-${name}.json`), JSON.stringify({ owner: "runtime", path: `scripts/${name}.test.ts`, ...(name === "serial" ? {} : { isolation: "process" }) }));
  writeFileSync(join(root, `scripts/${name}.test.ts`), `import { test, expect, mock } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const name = ${JSON.stringify(name)};
const events = process.env.EVENTS;
let step = 0;
mock.module(new URL("./value.ts", import.meta.url).pathname, () => ({ value: name }));
test("first test retains file-local state and module mock", async () => {
  expect(++step).toBe(1);
  expect((await import("./value.ts")).value).toBe(name);
  if (process.env.FAIL_FILE === name) process.exit(7);
  if (process.env.PAIRS === "1" && name !== "serial") expect(existsSync(join(events, "serial.done"))).toBe(true);
  writeFileSync(join(events, name + ".started"), String(process.pid), { flag: "wx" });
  if (process.env.PAIRS === "1" && name !== "serial") {
    const peer = { a: "b", b: "a", c: "d", d: "c" }[name];
    while (!existsSync(join(events, peer + ".started"))) await delay(10);
  }
  if (process.env.CANCEL === "1" && name !== "serial") {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: "ignore" });
    writeFileSync(join(events, name + ".descendant"), String(child.pid));
    await new Promise(() => {});
  }
}, 30000);
test("second test runs after the first in the same file", () => {
  expect(++step).toBe(2);
  writeFileSync(join(events, name + ".done"), "passed", { flag: "wx" });
});
`);
}

function start(root: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [join(root, "scripts/test-checks.ts"), "runtime"], {
    env: { ...process.env, BUN_WASM_RUNTIME_JOBS: undefined, TMPDIR: join(root, "tmp"), EVENTS: join(root, "events"), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, exited, output: () => output };
}

test.skipIf(process.platform !== "linux")("real serial and bounded runs have equivalent outcomes, selection, mocks and file order", async () => {
  for (const jobs of [undefined, "1", "2"]) {
    const root = fixture();
    const run = start(root, { BUN_WASM_RUNTIME_JOBS: jobs, PAIRS: jobs === "2" ? "1" : "0" });
    expect(await run.exited, run.output()).toBe(0);
    expect(readdirSync(join(root, "events")).filter(file => file.endsWith(".done")).sort()).toEqual(["a.done", "b.done", "c.done", "d.done", "serial.done"]);
    const pids = ["a", "b", "c", "d", "serial"].map(name => readFileSync(join(root, "events", `${name}.started`), "utf8"));
    expect(new Set(pids).size).toBe(jobs === "2" ? 5 : 1);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  }
}, 60000);

test.skipIf(process.platform !== "linux")("real runtime failure retains its original exit and drains active work", async () => {
  for (const failure of ["serial", "a"]) {
    const root = fixture();
    const run = start(root, { BUN_WASM_RUNTIME_JOBS: "2", FAIL_FILE: failure });
    expect(await run.exited, run.output()).toBe(7);
    if (failure === "serial") expect(readdirSync(join(root, "events"))).toEqual([]);
    const events = readdirSync(join(root, "events"));
    const started = events.filter(file => file.endsWith(".started")).map(file => file.replace(".started", ""));
    const done = events.filter(file => file.endsWith(".done")).map(file => file.replace(".done", ""));
    expect(done.sort()).toEqual(started.sort());
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  }
}, 60000);

test.skipIf(process.platform !== "linux")("a supervisor failure preserves scratch without declaring a successful drain", async () => {
  const root = fixture();
  writeFileSync(join(root, "scripts/run-with-timeout.mts"), 'throw new Error("injected supervisor failure");');
  const run = start(root, { BUN_WASM_RUNTIME_JOBS: "2" });
  expect(await run.exited).not.toBe(0);
  expect(run.output()).toContain("did not confirm drain; preserving scratch");
  expect(readdirSync(join(root, "tmp"))).toHaveLength(1);
  expect(readdirSync(join(root, "events"))).toEqual([]);
});

function verifyCancellation(signal: string): void {
  const root = fixture();
  const result = runSubreaperProbe([join(import.meta.dir, "fixtures/runtime-file-cancel.ts"), root, signal], 30000);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readdirSync(join(root, "tmp"))).toEqual([]);
  for (const file of readdirSync(join(root, "events"))) {
    if (!/\.(started|descendant)$/.test(file)) continue;
    expect(linuxProcess(Number(readFileSync(join(root, "events", file), "utf8")))).toBeUndefined();
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test.skipIf(process.platform !== "linux")(`${signal} drains detached descendants before removing owned scratch`, () => verifyCancellation(signal), 40000);
}
