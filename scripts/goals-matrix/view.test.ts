import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventory } from "./catalog";
import { deadlinePolicy } from "./deadlines";
import { combine } from "./fleet";
import { finish, initialCells, validateReport, type Report, type Attempt, type Cell, type RecordedBox } from "./model";
import { initialReport, options } from "./run";
import { completeAttempt } from "./test-fixture";
import { project, viewMarkdown, writeView } from "./view";

const box = { framework: "vite-react", browser: "chrome", engine: "browser" } as const;
function attempt(minute: number, failure?: "install" | "render" | "click" | "dev"): Attempt {
  const result = completeAttempt();
  result.startedAt = `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
  result.finishedAt = `2026-11-08T10:${String(minute).padStart(2, "0")}:30.000Z`;
  result.phases = result.phases.map(phase => ({ ...phase, startedAt: result.startedAt }));
  if (!failure) return result;
  const index = result.phases.findIndex(phase => phase.phase === failure);
  result.phases = result.phases.slice(0, index).concat([
    { phase: failure, status: "fail", error: `full ${failure} failure\nsecond line | details`, startedAt: result.startedAt, durationMs: 1, timeoutMs: 180_000 },
    { phase: "cleanup", status: "fail", error: "cleanup also failed", startedAt: result.finishedAt, durationMs: 0, timeoutMs: 20_000 },
  ]);
  return result;
}
function report(run = "first", minute = 1, failure?: Parameters<typeof attempt>[1]): Report {
  return { schema: 2, run, createdAt: "2026-11-08T10:00:00.000Z", command: "original command", source: { commit: run, dirty: false, assets: { hostSource: "product", engineBuilds: { browser: "digest" }, files: [{ path: "original", sha256: "original digest" }] } }, deadlines: deadlinePolicy(180_000),
    cells: initialCells().map(cell => cell.framework === box.framework && cell.browser === box.browser && cell.engine === box.engine ? finish(box, attempt(minute, failure)) : cell) };
}
function input(result: unknown, path = "/reports/first/TABLE.json") { return { path, contents: Buffer.from(JSON.stringify(result)) }; }

test("read-only projection preserves separate runner, product and policy identities without weakening combine", () => {
  const first = report(), second = report("second", 2, "install");
  second.deadlines = deadlinePolicy(180_000, { nuxt: 200_000 });
  expect(() => combine(first, second)).toThrow("sources");
  expect(() => combine(first, { ...second, source: first.source })).toThrow("deadline");
  const view = project([input(first), input(second, "/reports/second/TABLE.json")], [box]);
  expect(view).toMatchObject({ kind: "bun-wasm-goals-view", resumable: false });
  expect(view.inputs.map(item => item.report)).toEqual([first, second]);
  expect(view.inputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(view.cells[0]).toMatchObject({ overall: { status: "fail", phase: "install" }, latest: { input: 1, attempt: 0 }, install: { status: "fail" } });
  expect(() => validateReport(view)).toThrow("schema");
  expect(() => project([input(view)])).toThrow("schema");
  expect(() => combine(first, JSON.parse(JSON.stringify(view)))).toThrow("schema");
});

test("archive inventory retains parked engines and the original policy, but cannot resume", () => {
  const current = report();
  const { buildTimeouts: _builds, ...deadlines } = current.deadlines;
  const cells: Cell<RecordedBox>[] = current.cells;
  const archived = { ...current, deadlines, cells: cells.concat(inventory().filter(cell => cell.engine === "browser").map((cell): Cell<RecordedBox> => ({ ...cell, engine: "hermes", status: "pending", reason: "parked", attempts: [] }))) };
  expect(() => validateReport(archived)).toThrow();
  const view = project([input(archived)]);
  expect(view.inputs[0]?.report).toEqual(archived);
  expect(view.inputs[0]?.report.cells).toHaveLength(260);
  expect(view.cells).toHaveLength(208);
  expect(view.cells.map(cell => cell.engine)).not.toContain("hermes");
});

test("install pass never upgrades a later partial phase failure to overall PASS", () => {
  for (const failure of ["dev", "render", "click"] as const) {
    const original = report("first", 1, failure);
    const view = project([input(original)], [box]);
    expect(view.cells[0]).toMatchObject({ overall: { status: "fail", phase: failure }, install: { status: "pass" } });
    const markdown = viewMarkdown(view);
    expect(markdown).toContain(`FAIL (${failure})`);
    expect(markdown).toContain(`full ${failure} failure\nsecond line | details`);
    expect(markdown).toContain("cleanup also failed");
    expect(markdown).toContain("NON-RESUMABLE");
  }
});

test("latest finish then start wins regardless of input order or success, retaining every attempt", () => {
  const earlier = report(), later = report("second", 2, "click");
  const view = project([input(later), input(earlier, "/reports/second/TABLE.json")], [box]);
  expect(view.cells[0]?.overall).toMatchObject({ status: "fail", phase: "click" });
  expect(view.cells[0]?.attempts).toEqual([{ input: 1, cell: earlier.cells.findIndex(cell => cell.framework === box.framework && cell.browser === box.browser && cell.engine === box.engine), attempt: 0 }, { input: 0, cell: later.cells.findIndex(cell => cell.framework === box.framework && cell.browser === box.browser && cell.engine === box.engine), attempt: 0 }]);
  const retried = report("retry", 3, "render");
  const cell = retried.cells.find(cell => cell.framework === box.framework && cell.browser === box.browser && cell.engine === box.engine);
  if (!cell) throw new Error("Missing test cell");
  cell.attempts.unshift(attempt(1));
  expect(project([input(retried)], [box]).cells[0]?.attempts).toHaveLength(2);
});

test("finish time precedes start time, with start time breaking equal finishes", () => {
  const slow = report("slow", 1, "install"), fast = report("fast", 2);
  const slowAttempt = slow.cells.find(cell => cell.attempts.length)?.attempts[0];
  const fastAttempt = fast.cells.find(cell => cell.attempts.length)?.attempts[0];
  if (!slowAttempt || !fastAttempt) throw new Error("Missing test attempts");
  slowAttempt.finishedAt = "2026-11-08T10:03:00.000Z";
  expect(project([input(slow), input(fast, "/reports/fast.json")], [box]).cells[0]?.overall.status).toBe("fail");
  fastAttempt.finishedAt = slowAttempt.finishedAt;
  expect(project([input(slow), input(fast, "/reports/fast.json")], [box]).cells[0]?.overall.status).toBe("pass");
});

test("equal-time conflicts and duplicate identities fail, identical evidence keeps every source", () => {
  const first = report(), conflicting = report("second", 1, "click");
  expect(() => project([input(first), input(conflicting, "/reports/second/TABLE.json")])).toThrow("Ambiguous");
  expect(() => project([input(first), input(first, "/reports/copy.json")])).toThrow("Duplicate");
  expect(() => project([input(first), input(report("second"))])).toThrow("Duplicate");
  expect(project([input(first), input(report("second"), "/reports/second/TABLE.json")], [box]).cells[0]?.attempts).toHaveLength(2);
});

test("pending and later unavailable observations retain attempts, blockers and honest unattempted status", () => {
  const original = report(), unavailable = report("unavailable");
  unavailable.cells = initialCells().map(cell => ({ ...cell, status: "not runnable yet", reason: "driver unavailable", discovery: { error: "original blocker" } }));
  unavailable.createdAt = "2026-11-09T10:00:00.000Z";
  const view = project([input(original), input(unavailable, "/reports/unavailable.json")], [box, { ...box, browser: "safari" }]);
  expect(view.cells[0]?.overall.status).toBe("pass");
  expect(view.cells[0]?.observations).toHaveLength(2);
  expect(view.cells[1]).toMatchObject({ overall: { status: "unattempted" }, latest: null, install: null, attempts: [] });
  expect(viewMarkdown(view)).toContain("original blocker");
});

test("rejects wrong schema, malformed histories, phase evidence, times, inventory and policies", () => {
  expect(() => project([input({ ...report(), schema: 1 })])).toThrow("schema");
  const bad = report("bad", 1, "render");
  const cell = bad.cells.find(cell => cell.attempts.length);
  if (!cell?.attempts[0]) throw new Error("Missing test attempt");
  cell.attempts[0].finishedAt = "not a date";
  expect(() => project([input(bad)])).toThrow("time");
  cell.attempts[0].finishedAt = "2026-11-08T10:01:30";
  expect(() => project([input(bad)])).toThrow("time");
  cell.attempts[0].finishedAt = "2026-11-08T10:01:30.000Z";
  cell.attempts[0].phases.push(cell.attempts[0].phases[0]!);
  expect(() => project([input(bad)])).toThrow();
  expect(() => project([input({ ...report(), cells: report().cells.slice(1) })])).toThrow("inventory");
  expect(() => project([input({ ...report(), cells: report().cells.concat(report().cells.slice(0, 1)) })])).toThrow("duplicate");
  expect(() => project([input({ ...report(), deadlines: { ...report().deadlines, timeoutMs: -1 } })])).toThrow();
  const failed = report("bad", 1, "click");
  const malformed = JSON.parse(JSON.stringify(failed));
  malformed.cells.find((cell: { attempts: unknown[] }) => cell.attempts.length).attempts[0].phases[1].evidence.code = 1;
  expect(() => project([input(malformed)])).toThrow();
  const mismatched = report();
  mismatched.deadlines = deadlinePolicy(170_000);
  expect(() => project([input(mismatched)])).toThrow("Phase timeout differs");
});

test("CLI writes only a new view directory and refuses input overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-view-"));
  try {
    const path = join(root, "TABLE.json"), contents = JSON.stringify(report());
    await writeFile(path, contents);
    await expect(writeView([`--output=${root}`, path])).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(contents);
    await writeView([`--output=${root}/view`, "--frameworks=vite-react", "--browsers=chrome", "--engines=browser", path]);
    const saved = JSON.parse(await readFile(join(root, "view/VIEW.json"), "utf8"));
    expect(saved.cells).toHaveLength(1);
    expect(() => validateReport(saved)).toThrow("schema");
    expect(await readFile(path, "utf8")).toBe(contents);
    await expect(writeView([`--output=${root}/view`, path])).rejects.toThrow();
    await mkdir(join(root, "site"));
    await mkdir(join(root, "resume"));
    const stored = JSON.stringify(saved);
    await writeFile(join(root, "resume/TABLE.json"), stored);
    await expect(initialReport(options([`--root=${root}/site`, `--output=${root}/resume`, "--resume", "--asset-source=fixture"]))).rejects.toThrow("schema");
    expect(await readFile(join(root, "resume/TABLE.json"), "utf8")).toBe(stored);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("CLI rejects malformed UTF-8 without changing input or creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-view-utf8-"));
  try {
    const path = join(root, "TABLE.json"), output = join(root, "view");
    const bytes = Buffer.from(JSON.stringify(report("bad-BYTE")));
    const index = bytes.indexOf("BYTE");
    expect(index).toBeGreaterThan(-1);
    bytes[index] = 0xff;
    await writeFile(path, bytes);
    await expect(writeView([`--output=${output}`, path])).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
    expect(await readFile(path)).toEqual(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI binds a valid Unicode archive to its original UTF-8 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-view-bytes-"));
  try {
    const path = join(root, "TABLE.json"), output = join(root, "view");
    const original = report("café");
    const bytes = Buffer.from(JSON.stringify(original));
    await writeFile(path, bytes);
    await writeView([`--output=${output}`, path]);
    const saved = JSON.parse(await readFile(join(output, "VIEW.json"), "utf8"));
    expect(saved.inputs[0].sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(saved.inputs[0].report).toEqual(original);
    expect(await readFile(path)).toEqual(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
