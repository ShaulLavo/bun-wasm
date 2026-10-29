import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript-api";
import { acceptanceBudget, acceptanceTimeouts, timeoutOptions } from "./next-acceptance-options";
import { registryReceipt } from "./next-acceptance-registry";
import { runAcceptancePhase } from "./next-acceptance-phase";
import { fixtureSources, stageFixture } from "./next-acceptance-fixture";
import { emptyMemory, memoryGate, parseMemory, resultTable, type MemorySample, type PhaseResult } from "./next-acceptance-model";

const MiB = 1024 * 1024;
function sample(phase: string, live = 200): MemorySample {
  return { ...emptyMemory, phase, engine: "quickjs", time: Date.now(),
    wasmCapacityBytes: 450 * MiB, memoryLimitBytes: 512 * MiB, allocatorLiveBytes: live * MiB,
    allocatorPeakBytes: 460 * MiB, jsHeapBytes: 150 * MiB, arrayBufferBytes: 10 * MiB, swcBytes: 50 * MiB, notes: "test counters" };
}
const settled = () => [sample("warm:idle")].concat(Array.from({ length: 30 }, (_, index) => sample(`cycle:${index}:idle`, 201)));

test("memory gate separates capacity, live memory and peak headroom", () => {
  expect(memoryGate(settled(), 30, 32, 16).status).toBe("pass");
  const highCapacity = settled().map(value => ({ ...value, wasmCapacityBytes: 512 * MiB }));
  expect(memoryGate(highCapacity, 30, 32, 16).status).toBe("pass");
  const peak = settled().concat([{ ...sample("dev:cycle:14"), allocatorPeakBytes: 500 * MiB }]);
  expect(memoryGate(peak, 30, 32, 16).status).toBe("fail");
  expect(memoryGate(settled().map(value => ({ ...value, jsHeapBytes: value.phase === "warm:idle" ? 150 * MiB : 300 * MiB })), 30, 32, 16).status).toBe("fail");
});

test("memory gate refuses partial sessions, missing attribution and retention growth", () => {
  expect(memoryGate(settled(), 29, 32, 16).status).toBe("blocked");
  expect(memoryGate(settled().map(value => ({ ...value, allocatorLiveBytes: null })), 30, 32, 16).status).toBe("blocked");
  expect(memoryGate([sample("warm:idle")].concat(Array.from({ length: 30 }, (_, index) => sample(`cycle:${index}:idle`, 200 + index * 3))), 30, 32, 16).status).toBe("fail");
});

test("memory hook validates counters and failed-allocation evidence", () => {
  expect(parseMemory({ ...emptyMemory, failedAllocation: { bytes: 1048576, category: "typed-array" } }).failedAllocation?.bytes).toBe(1048576);
  for (const value of [-1, Infinity, "1024", undefined]) expect(() => parseMemory({ ...emptyMemory, jsHeapBytes: value })).toThrow();
  expect(() => parseMemory({ ...emptyMemory, failedAllocation: { bytes: -4, category: "typed-array" } })).toThrow();
});

test("report records blocked phases and engine identity without unescaped table cells", () => {
  const table = resultTable([{ phase: "dev", engine: "jsc", observedEngine: "ready | JavaScriptCore", durationMs: 20, budgetMs: null, status: "blocked", reason: "build\nfailed" }]);
  expect(table).toContain("jsc | ready \\| JavaScriptCore | dev | blocked");
  expect(table).toContain("build failed");
  expect(table).toContain("Watchdog ms");
  expect(table).toContain("20 | n/a | build failed");
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", ".next"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}
function deepBlocks(file: string): string[] {
  const root = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const visit = (node: ts.Node, depth: number) => {
    const next = depth + Number(ts.isBlock(node) || ts.isCaseBlock(node));
    if (next > 3 && ts.isBlock(node)) failures.push(`${file}:${root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1}`);
    ts.forEachChild(node, child => visit(child, next));
  };
  visit(root, 0);
  return failures;
}
test("acceptance implementation and fixture stay within three block levels", () => {
  const directory = import.meta.dir;
  const runner = readdirSync(directory).filter(name => /^next-acceptance.*\.ts$/.test(name)).map(name => join(directory, name));
  expect(runner.concat(sourceFiles(join(directory, "../../examples/next-acceptance"))).flatMap(deepBlocks)).toEqual([]);
});


test("every engine stages the same TS-authored config as native ESM", async () => {
  const sources = fixtureSources(join(import.meta.dir, "../../examples/next-acceptance"));
  const staged = stageFixture(sources);
  expect(staged.files["next.config.ts"]).toBeUndefined();
  expect(staged.files["next.config.mjs"]).toContain("export default");
  expect(staged.config.sourceSha256).toHaveLength(64);
  expect(staged.config.generatedSha256).toHaveLength(64);
  expect(sources["next.config.ts"]).toContain("import type");
  const module = await import("data:text/javascript;base64," + Buffer.from(staged.files["next.config.mjs"] ?? "").toString("base64"));
  expect(module.default).toEqual({ outputFileTracingRoot: process.cwd(), agentRules: false, experimental: { cpus: 1 } });
});


test("real launcher preserves exact dev/build/start argv", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-next01-argv-"));
  try {
    const bin = join(scratch, "node_modules/next/dist/bin/next");
    mkdirSync(join(scratch, "node_modules/next/dist/bin"), { recursive: true });
    writeFileSync(bin, "process.stdout.write(JSON.stringify(process.argv));\n");
    writeFileSync(join(scratch, "launch.ts"), readFileSync(join(import.meta.dir, "../../examples/next-acceptance/launch.ts")));
    for (const args of [["dev", "--webpack", "--hostname", "127.0.0.1", "--port", "43701"], ["build", "--webpack"], ["start", "--hostname", "127.0.0.1", "--port", "43701"]]) verifyLauncher(scratch, bin, args);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

function verifyLauncher(directory: string, bin: string, args: string[]) {
  const child = Bun.spawnSync([process.execPath, "run", "launch.ts"].concat(args), { cwd: directory });
  expect(child.exitCode).toBe(0);
  const actual: unknown = JSON.parse(child.stdout.toString());
  expect(Array.isArray(actual) ? actual.slice(1) : actual).toEqual([bin].concat(args));
}

function selectedTimeouts(args: string[] = []) {
  return acceptanceTimeouts(parseArgs({ args, options: timeoutOptions }).values);
}

test("only production builds receive the approved 300-second operation budget", () => {
  const timeouts = selectedTimeouts();
  expect(timeouts).toEqual({ timeoutMs: 180000, buildTimeoutMs: 300000 });
  expect(acceptanceBudget("build", timeouts)).toEqual({ operationMs: 300000, watchdogMs: 305000 });
  for (const name of ["assets", "engine", "install", "start", "dev", "start:http-ready", "dev:static", "dev:cycle:0", "dev:compile-recovery", "start:stop", "dev:stop", "network"]) {
    expect(acceptanceBudget(name, timeouts)).toEqual({ operationMs: 180000, watchdogMs: 185000 });
  }
});

test("build and other-operation timeout overrides are independent", () => {
  const buildOnly = selectedTimeouts(["--build-timeout-ms", "240000"]);
  expect(acceptanceBudget("build", buildOnly)).toEqual({ operationMs: 240000, watchdogMs: 245000 });
  expect(acceptanceBudget("install", buildOnly)).toEqual({ operationMs: 180000, watchdogMs: 185000 });
  const otherOnly = selectedTimeouts(["--timeout-ms", "60000"]);
  expect(acceptanceBudget("build", otherOnly)).toEqual({ operationMs: 300000, watchdogMs: 305000 });
  expect(acceptanceBudget("dev:cycle:0", otherOnly)).toEqual({ operationMs: 60000, watchdogMs: 65000 });
  expect(selectedTimeouts(["--timeout-ms", "1000", "--build-timeout-ms", "900000"]))
    .toEqual({ timeoutMs: 1000, buildTimeoutMs: 900000 });
});

test("both timeout options reject values outside their integer bounds", () => {
  for (const option of Object.keys(timeoutOptions)) {
    for (const value of ["", "0", "-1", "999", "900001", "1000.5", "NaN", "Infinity", "not-a-number", "9007199254740992"]) {
      expect(() => selectedTimeouts([`--${option}=${value}`])).toThrow(`Invalid --${option}`);
    }
    expect(() => selectedTimeouts([`--${option}`])).toThrow();
  }
});

test("phase reports persist the selected build watchdog and the actual operation failure", async () => {
  const { watchdogMs } = acceptanceBudget("build", selectedTimeouts(["--build-timeout-ms", "250000"]));
  const rows: PhaseResult[] = [];
  const result = await runAcceptancePhase({ phase: "build", engine: "quickjs", observedEngine: "QuickJS control",
    timeoutMs: watchdogMs, operation: async () => { throw new Error("build exited 7"); },
    cancel: async () => { throw new Error("completed operations must not be cancelled"); }, record: row => rows.push(row) });
  expect(result).toMatchObject({ phase: "build", budgetMs: 255000, status: "fail", reason: "Error: build exited 7" });
  expect(rows).toEqual([result]);
  expect(JSON.parse(JSON.stringify(rows))[0].budgetMs).toBe(255000);
  expect(resultTable(rows)).toContain("255000 | Error: build exited 7");
});

test("an expired stage waits for cancellation before recording failure even if work completes during teardown", async () => {
  const events: string[] = [];
  let finish = () => {};
  const operation = new Promise<void>(resolve => { finish = resolve; });
  const rows: PhaseResult[] = [];
  const result = await runAcceptancePhase({ phase: "build", engine: "quickjs", observedEngine: "QuickJS control", timeoutMs: 10,
    operation: () => operation,
    cancel: async () => { events.push("cancel"); await Promise.resolve(); finish(); events.push("released"); },
    record: row => { events.push("record"); rows.push(row); } });
  expect(events).toEqual(["cancel", "released", "record"]);
  expect(result).toMatchObject({ status: "fail", budgetMs: 10, reason: "Error: Phase build deadline exceeded (10ms)" });
  expect(rows).toEqual([result]);
});


test("registry overlay without a supplement rejects before report or session resources exist", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-next01-options-"));
  try {
    const output = join(scratch, "report");
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "next-acceptance.ts"),
      "--engine", "quickjs", "--web-root", join(scratch, "unused-web"), "--output", output,
      "--runtime-revision", "d7fa432cbf03276c0c39119444bb524ce80db0ba",
      "--registry-overlay", join(import.meta.dir, "fixtures/next-advisory")],
    { env: { ...process.env, TMPDIR: scratch, BUN_WASM_TEST_TMP: scratch }, timeout: 5000 });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain("--registry-overlay requires --registry-extra");
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("registry receipt identifies all three indexes and changes with the authentic overlay bytes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-next01-receipt-"));
  try {
    const captured = readFileSync(join(import.meta.dir, "fixtures/next-advisory/index.json"), "utf8");
    const paths = ["borrowed", "supplement", "overlay"].map(name => join(scratch, `${name}.json`));
    for (const path of paths) writeFileSync(path, captured);
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const receipt = registryReceipt(paths);
    expect(receipt.entries).toBe(1);
    expect(receipt.sha256).toBe(hash([captured, captured, captured].join("\n")));
    expect(receipt.inputs).toEqual(paths.map(path => ({ path, sha256: hash(captured), entries: 1 })));
    expect(registryReceipt(paths.slice(0, 2)).sha256).not.toBe(receipt.sha256);
    const overlay = paths.at(-1);
    if (!overlay) throw new Error("Missing overlay input");
    writeFileSync(overlay, captured + "\n");
    const changed = registryReceipt(paths);
    expect(changed.sha256).not.toBe(receipt.sha256);
    expect(changed.entries).toBe(receipt.entries);
    expect(changed.inputs.slice(0, 2)).toEqual(receipt.inputs.slice(0, 2));
    expect(changed.inputs.at(-1)?.sha256).toBe(hash(captured + "\n"));
    rmSync(overlay);
    expect(() => registryReceipt(paths)).toThrow("ENOENT");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
