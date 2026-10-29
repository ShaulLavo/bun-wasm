import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";
import { fixtureSources, stageFixture } from "./next-acceptance-fixture";
import { emptyMemory, memoryGate, parseMemory, resultTable, type MemorySample } from "./next-acceptance-model";

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
  const table = resultTable([{ phase: "dev", engine: "jsc", observedEngine: "ready | JavaScriptCore", durationMs: 20, status: "blocked", reason: "build\nfailed" }]);
  expect(table).toContain("jsc | ready \\| JavaScriptCore | dev | blocked");
  expect(table).toContain("build failed");
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
