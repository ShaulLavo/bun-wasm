import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { completeStackParts, stackSelection } from "./stack-parts.ts";
import { stackModeSlice } from "./stack-measurement.ts";
import { cleanupPlayground } from "../web/tests/playground-cleanup.ts";

const owned: string[] = [];
afterAll(() => { for (const directory of owned) rmSync(directory, { recursive: true, force: true }); });
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-stack-parts-"));
owned.push(scratch);
const host = "chromium/jsc";
const provider = new URL("./fixtures/stack-measurement-provider.ts", import.meta.url).pathname;

function harness(slice: string | undefined, scenario = "safe", cold = true, overrides: Record<string, string> = {}, measure = true) {
  const directory = mkdtempSync(join(scratch, "run-"));
  const args = ["node", "--import", provider, "web/tests/browser-stack.mjs"].concat(measure ? ["--measure"] : [], cold ? ["--cold"] : [], ["chromium"]);
  const result = Bun.spawnSync(args, {
    cwd: resolve(import.meta.dir, ".."), timeout: 10000,
    env: { ...process.env, ENGINES: "jsc", STACK_SLICE: slice, STACK_KIB: undefined, JSC_PARSER_RESERVE: undefined,
      STACK_TEST_ROOT: directory, STACK_TEST_SCENARIO: scenario, STACK_TEST_OUTPUT: undefined,
      STACK_TEST_RECORD_COMMANDS: "1", STACK_TEST_GUEST_SETTINGS: undefined, STACK_TEST_FIXTURE_FAILURE: undefined, ...overrides },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const rows = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  return { directory, stdout, rows, result };
}

test("every legal partition is nonempty, ordered, disjoint and covers the original sweep", () => {
  const whole = stackModeSlice(0, 1);
  expect(stackSelection(undefined, false).modes).toEqual(whole);
  for (let count = 1; count <= whole.length; count++) {
    const parts = Array.from({ length: count }, (_, index) => stackSelection(`${index + 1}/${count}`, true));
    expect(parts.flatMap(part => part.modes)).toEqual(whole);
    expect(new Set(parts.flatMap(part => part.modes)).size).toBe(whole.length);
    expect(parts.every(part => part.modes.length > 0)).toBe(true);
    expect(parts.flatMap(part => part.fixtures)).toEqual(stackSelection(undefined, true).fixtures);
    expect(stackSelection(`1-${count}/${count}`, true).modes).toEqual(whole);
  }
  expect(stackSelection("2-3/4", true).modes).toEqual(stackModeSlice(1, 4).concat(stackModeSlice(2, 4)));
  expect(stackSelection("2-3/4", true).fixtures).toEqual([]);
  expect(stackSelection("1-2/4", true).fixtures).toEqual(["stack-overflow", "stack-overflow-console"]);
});

for (const slice of ["", "0/4", "1/0", "5/4", "3-2/4", "1/49", "1/1.5", "1/NaN", "01/4", " 1/4", "1/4\n", "1-9/4", "1/9007199254740992", "1-9007199254740992/4", "9007199254740993/4", "1/4/2"]) {
  test(`rejects unsafe or malformed selection ${JSON.stringify(slice)} before acquiring resources`, () => {
    expect(() => stackSelection(slice, true)).toThrow();
    const run = harness(slice);
    expect(run.result.exitCode).not.toBe(0);
    expect(readdirSync(run.directory)).toEqual([]);
  });
}

test("parts require measurement and cannot silently become fixture-only passes", () => {
  expect(() => stackSelection("1/4", false)).toThrow("requires --measure");
  const run = harness("1/4", "safe", true, {}, false);
  expect(run.result.exitCode).not.toBe(0);
  expect(readdirSync(run.directory)).toEqual([]);
});

test("default output and fixture-only behavior stay unchanged", () => {
  const run = harness(undefined);
  expect(run.result.exitCode).toBe(0);
  expect(run.rows.filter(row => row.mode).map(row => row.mode)).toEqual(stackModeSlice(0, 1));
  expect(run.rows.some(row => row.stackSelection || row.stackPartComplete)).toBe(false);
  expect(run.stdout).toEndWith(`ok ${host} stack-overflow\nok ${host} stack-overflow-console\n`);
  const fixtures = harness(undefined, "safe", false, {}, false);
  expect(fixtures.result.exitCode).toBe(0);
  expect(fixtures.rows).toEqual([]);
  expect(fixtures.stdout).toBe(`ok ${host} stack-overflow\nok ${host} stack-overflow-console\n`);
});

test("selected cold attempts keep independent contexts; warm attempts reuse one", () => {
  for (const cold of [true, false]) {
    const slice = cold ? "1-2/4" : "1-4/4";
    const run = harness(slice, "safe", cold);
    expect(run.result.exitCode).toBe(0);
    expect(run.rows[0]).toMatchObject({ host, cold, stackSelection: stackSelection(slice, true, cold) });
    expect(run.rows.filter(row => row.mode).map(row => row.mode)).toEqual(stackSelection(slice, true, cold).modes);
    const commands: string[] = readFileSync(join(run.directory, "browser-commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const cleanup = readFileSync(join(run.directory, "cleanup.log"), "utf8").trim().split("\n");
    expect(cleanup.filter(kind => kind === "context").length).toBe(cold ? commands.length + 1 : 1);
    expect(cleanup.filter(kind => kind === "visit").length).toBe(cold ? commands.length + 1 : 1);
    expect(readdirSync(run.directory).sort()).toEqual(["browser-commands.jsonl", "cleanup.log"]);
  }
});

test("warm qualification rejects separate contexts and accepts one continuous full sweep", () => {
  for (const slice of ["1/4", "2-4/4"]) {
    expect(() => stackSelection(slice, true, false)).toThrow("one full sweep");
    const run = harness(slice, "safe", false);
    expect(run.result.exitCode).not.toBe(0);
    expect(readdirSync(run.directory)).toEqual([]);
  }
  const parts = [harness("1/2").stdout, harness("2/2").stdout].map(text => text.replace('"cold":true', '"cold":false'));
  expect(() => completeStackParts(parts, host)).toThrow("one full sweep");
  for (const slice of ["1/1", "1-4/4"]) {
    const run = harness(slice, "safe", false);
    expect(run.result.exitCode).toBe(0);
    expect(completeStackParts([run.stdout], host)).toMatchObject({ cold: false, complete: true });
  }
});

test("real playground cleanup reaps owned children before resolving or removing scratch", async () => {
  const directory = mkdtempSync(join(scratch, "real-child-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const closed = once(child, "close");
  let reaped = false;
  child.once("close", () => { reaped = true; });
  try {
    await once(child, "spawn");
    await cleanupPlayground({ browsers: [], children: [child], scratch: directory });
    expect(reaped).toBe(true);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(readdirSync(scratch)).not.toContain(directory.slice(scratch.length + 1));
    await cleanupPlayground({ browsers: [], children: [child], scratch: directory });
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});

test("a browser cleanup failure still reaps children and rejects completion", async () => {
  const directory = mkdtempSync(join(scratch, "cleanup-failure-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const closed = once(child, "close");
  try {
    await once(child, "spawn");
    const browsers = [{ close: async () => { throw new Error("close failed"); } }];
    await expect(cleanupPlayground({ browsers, children: [child], scratch: directory })).rejects.toThrow("browsers did not close");
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});

test("completion requires every part, every mode and both successful fixtures", () => {
  const runs = Array.from({ length: 4 }, (_, index) => harness(`${index + 1}/4`));
  for (const run of runs) expect(run.result.exitCode).toBe(0);
  const transcripts = runs.map(run => run.stdout);
  expect(completeStackParts(transcripts.toReversed(), host)).toMatchObject({ complete: true, modes: 48, parts: 4 });
  expect(() => completeStackParts(transcripts.slice(1), host)).toThrow("Missing stack parts");
  expect(() => completeStackParts(transcripts.concat([transcripts[0]!]), host)).toThrow("Duplicate stack part");
  expect(() => completeStackParts([], host)).toThrow();
  expect(() => completeStackParts(transcripts, "webkit/jsc")).toThrow("host");
  const first = transcripts[0]!;
  const row = first.split("\n").find(line => line.includes('"mode":"plain"'))!;
  for (const changed of [
    first.replace(row + "\n", ""), first.replace(row, row + "\n" + row),
    first.replace('"failures":[]', '"failures":[{"depth":100000,"outcome":"trap"}]'),
    first.replace('"at_max":"caught:RangeError"', '"at_max":"trap"'),
    first.replace('"beyond":"caught:RangeError"', '"beyond":"timeout"'),
    first.replace(`ok ${host} stack-overflow\n`, ""),
    first.replace(/\{[^\n]*"stackPartComplete"[^\n]*\}\n/, ""),
    first.replace('"cold":true', '"cold":false'),
    first.replace('"budget":null', '"budget":"240"'),
  ]) expect(() => completeStackParts([changed].concat(transcripts.slice(1)), host)).toThrow();
  const range = harness("1-2/4");
  expect(completeStackParts([range.stdout].concat(transcripts.slice(2)), host).complete).toBe(true);
  expect(() => completeStackParts([range.stdout].concat(transcripts), host)).toThrow("Duplicate stack part");
  expect(() => completeStackParts([harness("1/3").stdout].concat(transcripts.slice(1)), host)).toThrow("part count");
});

for (const scenario of ["hidden", "hidden-timeout", "final", "missing", "unexpected", "wrong-depth", "duplicate-continuation", "timeout", "throw", "context-close", "browser-close", "session-close"]) {
  test(`a selected part preserves ${scenario} failure and cleanup`, () => {
    const run = harness("1/4", scenario);
    expect(run.result.exitCode).not.toBe(0);
    expect(run.stdout).not.toContain('"stackPartComplete"');
    expect(() => completeStackParts([run.stdout], host)).toThrow();
    expect(readdirSync(run.directory).sort()).toEqual(["browser-commands.jsonl", "cleanup.log"]);
  });
}

test("selected runs preserve explicit settings and reject a guest settings mismatch", () => {
  const settings = { budget: "240", parserReserve: "832" };
  const good = harness("1/1", "safe", true, { STACK_KIB: "240", JSC_PARSER_RESERVE: "832", STACK_TEST_GUEST_SETTINGS: JSON.stringify(settings) });
  expect(good.result.exitCode).toBe(0);
  expect(completeStackParts([good.stdout], host)).toMatchObject({ requested: settings, complete: true });
  const bad = harness("1/4", "safe", true, { STACK_KIB: "240", STACK_TEST_GUEST_SETTINGS: JSON.stringify({ ...settings, budget: "256" }) });
  expect(bad.result.exitCode).not.toBe(0);
  expect(bad.stdout).toContain("settings-mismatch");
  expect(bad.stdout).not.toContain('"stackPartComplete"');
});

test("the rerunnable completion command accepts a full explicit part and rejects a partial one", () => {
  const file = join(scratch, "completion.jsonl");
  const command = ["bun", "scripts/stack-parts.ts", host, file];
  writeFileSync(file, harness("1/1").stdout);
  const full = Bun.spawnSync(command, { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(full.exitCode).toBe(0);
  expect(JSON.parse(full.stdout.toString())).toMatchObject({ host, modes: 48, parts: 1, complete: true });
  writeFileSync(file, harness("1/4").stdout);
  const partial = Bun.spawnSync(command, { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(partial.exitCode).not.toBe(0);
  expect(partial.stderr.toString()).toContain("Missing stack parts");
});

for (const fixture of ["stack-overflow", "stack-overflow-console"]) {
  test(`a failing ${fixture} rejects the fixture-owning part`, () => {
    const run = harness("1/4", "safe", true, { STACK_TEST_FIXTURE_FAILURE: fixture });
    expect(run.result.exitCode).not.toBe(0);
    expect(run.stdout).not.toContain('"stackPartComplete"');
    expect(() => completeStackParts([run.stdout], host)).toThrow();
    expect(readdirSync(run.directory).sort()).toEqual(["browser-commands.jsonl", "cleanup.log"]);
  });
}
