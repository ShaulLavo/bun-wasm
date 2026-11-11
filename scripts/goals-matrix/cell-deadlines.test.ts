import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reviewed from "./cell-deadlines.json";
import { calibrate, calibrationMarkdown, sha256 } from "./calibrate-deadlines";
import { campaignDeadlines, cellDeadlines, deadlinePolicy, sameDeadlines, validateDeadlines } from "./deadlines";
import { inventory, boxId, type Box } from "./catalog";
import { completeAttempt } from "./test-fixture";
import { initialCells, finish, validateReport, type Attempt, type Report } from "./model";
import { initialReport, options } from "./run";
import { nativeRunnerArgs } from "./fleet";
import { deadlineMarkdown, saveReport } from "./report";
import { policyMetadata, policyMarkdown, stagePolicyMetadata } from "./policy-metadata";
import { validateArchive } from "./archive";

function attempt(box: Box, at: number, shared = 1000, install = 2000, build = 3000): Attempt {
  const result = completeAttempt();
  result.startedAt = new Date(at).toISOString(); result.finishedAt = new Date(at + 500_000).toISOString();
  result.browser = { browserName: box.browser === "iphone-safari" ? "safari" : box.browser, platformName: box.browser === "iphone-safari" ? "ios" : "macOS", "safari:useSimulator": true };
  result.phases = result.phases.map(phase => ({ ...phase, startedAt: result.startedAt,
    durationMs: phase.phase === "render" ? shared : phase.phase === "install" ? install : phase.phase === "build" ? build : 1,
    evidence: phase.phase === "startup" ? { ready: true, engine: box.engine, status: "ready", agent: "fixture" } : phase.status === "pass" ? phase.evidence : {} }));
  return result;
}
const date = Date.parse("2026-11-10T12:00:00Z");
function input() { return { schema: 2, run: "frozen-fixture", createdAt: "2026-11-11T20:01:42.710Z", source: { commit: "original", dirty: false, assets: {} }, cells: initialCells() }; }
function calibrated(table: ReturnType<typeof input>, box: Box) {
  const result = calibrate(JSON.stringify(table)).cells.find(cell => boxId(cell) === boxId(box));
  if (!result) throw new Error("Missing calibrated cell");
  return result;
}
function setCell(table: ReturnType<typeof input>, box: Box, attempts: Attempt[]): void {
  const index = table.cells.findIndex(cell => boxId(cell) === boxId(box));
  const last = attempts.at(-1);
  if (!last) throw new Error("Missing fixture attempt");
  table.cells[index] = finish(box, last, attempts.slice(0, -1));
}
test("reviewed Next Browser builds use exact 12.5% headroom with no arbitrary floor", () => {
  const policy = campaignDeadlines();
  expect(cellDeadlines(policy, { framework: "next", browser: "chrome", engine: "browser" })).toEqual({ timeoutMs: 4926, installTimeoutMs: 19782, buildTimeoutMs: 25072 });
  expect(cellDeadlines(policy, { framework: "next", browser: "firefox", engine: "browser" })).toEqual({ timeoutMs: 5692, installTimeoutMs: 20059, buildTimeoutMs: 43168 });
  expect(policy.cleanupTimeoutMs).toBe(20_000);
});
test("shared phase and install lookup use framework, browser and engine independently", () => {
  const policy = campaignDeadlines();
  const boxes: Box[] = [{ framework: "next", browser: "chrome", engine: "browser" }, { framework: "next", browser: "firefox", engine: "browser" }, { framework: "next", browser: "chrome", engine: "quickjs" }, { framework: "hono", browser: "chrome", engine: "browser" }];
  const limits = boxes.map(box => cellDeadlines(policy, box));
  expect(new Set(limits.map(limit => limit.timeoutMs)).size).toBe(4);
  expect(new Set(limits.map(limit => limit.installTimeoutMs)).size).toBe(4);
  expect(validateDeadlines(policy)).toEqual(policy);
});
test("every in-guest cell can tighten but never widen, and exempt/no-pass cells retain defaults", () => {
  const policy = campaignDeadlines();
  for (const box of inventory()) {
    const cell = reviewed.cells.find(cell => `${cell.framework}/${cell.browser}/${cell.engine}` === boxId(box));
    if (!cell) throw new Error("Missing policy cell");
    const defaults = cellDeadlines(deadlinePolicy(), box);
    const actual = cellDeadlines(policy, box);
    if (cell.kind !== "calibrated") expect(actual).toEqual(defaults);
    if (cell.engine === "browser") continue;
    expect(actual.timeoutMs).toBeLessThanOrEqual(defaults.timeoutMs);
    expect(actual.installTimeoutMs).toBeLessThanOrEqual(defaults.installTimeoutMs);
    expect(actual.buildTimeoutMs).toBeLessThanOrEqual(defaults.buildTimeoutMs);
  }
  const table = input(), box: Box = { framework: "next", browser: "chrome", engine: "quickjs" };
  setCell(table, box, [attempt(box, date, 100_000, 100_000, 100_000)]);
  expect(calibrated(table, box).limits).toEqual({ timeoutMs: 90_000, installTimeoutMs: 90_000, buildTimeoutMs: 110_000 });
});
test("selection uses actual finish then start time, never report time, order or a partial success", () => {
  const table = input(), box: Box = { framework: "next", browser: "chrome", engine: "browser" };
  const older = attempt(box, date, 100, 200, 300), latest = attempt(box, date + 1000, 4001, 5001, 6001);
  const earlierStart = attempt(box, date - 1000, 5, 6, 7);
  earlierStart.finishedAt = latest.finishedAt;
  const partial = attempt(box, date + 10_000, 10, 20, 30);
  partial.phases = partial.phases.filter(phase => phase.phase !== "cleanup");
  setCell(table, box, [latest, earlierStart, older]);
  const cell = table.cells.find(cell => boxId(cell) === boxId(box));
  if (!cell) throw new Error("Missing fixture cell");
  cell.attempts.push(partial);
  const before = JSON.stringify(table);
  const result = calibrated(table, box);
  expect(result).toMatchObject({ kind: "calibrated", measured: { timeoutMs: 4001, installTimeoutMs: 5001, buildTimeoutMs: 6001 }, limits: { timeoutMs: 4502, installTimeoutMs: 5627, buildTimeoutMs: 6752 }, attempt: { startedAt: latest.startedAt, finishedAt: latest.finishedAt, sha256: sha256(JSON.stringify(latest)) } });
  expect(JSON.stringify(table)).toBe(before);
});
test.each(["startup", "dev", "render", "click", "hot-reload", "preview"])("shared timeout includes %s while excluding install, build and cleanup", phase => {
  const table = input(), box = inventory()[0]!, complete = attempt(box, date, 1, 50_000, 60_000);
  const selected = complete.phases.find(result => result.phase === phase);
  const cleanup = complete.phases.find(result => result.phase === "cleanup");
  if (!selected || !cleanup) throw new Error("Missing fixture phase");
  selected.durationMs = 12345; cleanup.durationMs = 19_000;
  setCell(table, box, [complete]);
  expect(calibrated(table, box).limits).toEqual({ timeoutMs: 13889, installTimeoutMs: 56250, buildTimeoutMs: 67500 });
});
test("a failed current cell can use its latest complete canonical history, without mixing phases", () => {
  const table = input(), box: Box = { framework: "hono", browser: "firefox", engine: "browser" };
  const pass = attempt(box, date), failed = attempt(box, date + 10_000, 80_000, 80_000, 80_000);
  failed.phases[6] = { phase: "build", startedAt: failed.startedAt, durationMs: 80_000, timeoutMs: 90_000, status: "fail", error: "real failure" };
  const index = table.cells.findIndex(cell => boxId(cell) === boxId(box));
  const history = { ...finish(box, pass), sourceReport: "original-pass.json", sourceCreatedAt: "2026-11-11T01:00:00Z" };
  const current = { ...finish(box, failed), history: [history], sourceReport: "newer-failed.json", sourceCreatedAt: "2026-11-11T22:00:00Z" };
  table.cells[index] = current;
  const before = JSON.stringify(table);
  expect(calibrated(table, box)).toMatchObject({ limits: { timeoutMs: 1125, installTimeoutMs: 2250, buildTimeoutMs: 3375 }, attempt: { location: `cells[${index}].history[0].attempts[0]`, sourceReport: "original-pass.json", sourceCreatedAt: history.sourceCreatedAt } });
  current.history = [];
  expect(calibrated(table, box).kind).toBe("no-complete-pass");
  current.history = [history];
  expect(JSON.stringify(table)).toBe(before);
});
test("Next SpiderMonkey is exempt even with a complete pass, and retains deliberate lane overrides", () => {
  const table = input(), box: Box = { framework: "next", browser: "firefox", engine: "spidermonkey" };
  setCell(table, box, [attempt(box, date)]);
  expect(calibrated(table, box)).toMatchObject({ kind: "exempt-next-spidermonkey", limits: { timeoutMs: 90_000, installTimeoutMs: 90_000, buildTimeoutMs: 110_000 } });
  expect(cellDeadlines(campaignDeadlines(180_000, { next: 220_000 }), box)).toEqual({ timeoutMs: 180_000, installTimeoutMs: 220_000, buildTimeoutMs: 180_000 });
});
test("fixed policy records decision date, margin, frozen identity and immutable attempt provenance", () => {
  expect(reviewed.metadata).toMatchObject({ decisionDate: "2026-11-11", margin: 0.125, source: { path: "/work/reports/goals/TABLE.json", sha256: "96ebe1aba8032b12dc9e3077a9bad97f5e9c4967fd970d7cbc3b4e1bbf822ad2", run: "60ab3cfb-4da8-4782-aff1-e839ff1831a1" } });
  const markdown = deadlineMarkdown(campaignDeadlines());
  expect(markdown).toContain("2026-11-11"); expect(markdown).toContain("12.5%");
  expect(markdown).toContain("| Next.js | chrome | browser | 4926 | 19782 | 25072 |");
  expect(markdown).toContain(reviewed.metadata.source.sha256);
  const table = input(), box = inventory()[0]!;
  setCell(table, box, [attempt(box, date)]);
  expect(calibrationMarkdown(calibrate(JSON.stringify(table)))).toContain("| next/chrome/browser | 90000 | 1125 | 90000 | 2250 | 110000 | 3375 | calibrated |");
});
test("equal-time conflicting complete passes are rejected, and changing one report cannot change fixed runtime policy", () => {
  const table = input(), box = inventory()[0]!;
  setCell(table, box, [attempt(box, date), attempt(box, date, 2000)]);
  expect(() => calibrate(JSON.stringify(table))).toThrow("Ambiguous complete passes");
  const changed = campaignDeadlines();
  if (!changed.calibration || !changed.cellTimeouts) throw new Error("Missing calibration");
  changed.calibration.source.sha256 = "0".repeat(64);
  changed.cellTimeouts[boxId(box)]!.buildTimeoutMs = 999_999;
  expect(cellDeadlines(campaignDeadlines(), box).buildTimeoutMs).toBe(25072);
  expect(campaignDeadlines().calibration?.source.sha256).toBe(reviewed.metadata.source.sha256);
});
test("fleet standard defaults never forward a uniform override, while deliberate overrides remain recorded", () => {
  const config = options(["--asset-source=fixture", "--browsers=safari", "--mac-lane=deadlines", "--mac-thread=0d4397e9-4028-43c4-8183-4d9dfb64821f"]);
  const args = nativeRunnerArgs(config, "/Users/fixture/tmp/goals");
  expect(args.some(arg => arg.startsWith("--timeout-ms"))).toBe(false);
  expect(options(args).timeoutMs).toBeUndefined();
  expect(campaignDeadlines(options(args).timeoutMs)).toEqual(campaignDeadlines());
  expect(campaignDeadlines(90_000).overrides?.timeoutMs).toBe(90_000);
  expect(sameDeadlines(campaignDeadlines(), campaignDeadlines(90_000))).toBe(false);
});
test("per-cell report validation and archive reading enforce recorded limits, never rewrite old attempts", () => {
  const box = inventory()[0]!;
  const report: Report = { schema: 2, run: "fixture", createdAt: "2026-11-11T20:00:00Z", command: "fixture", source: { commit: "original", dirty: false, assets: {} }, cells: initialCells(), deadlines: campaignDeadlines() };
  const original = attempt(box, date), limits = cellDeadlines(report.deadlines, box);
  for (const phase of original.phases) phase.timeoutMs = phase.phase === "cleanup" ? 20_000 : phase.phase === "install" ? limits.installTimeoutMs : phase.phase === "build" ? limits.buildTimeoutMs : limits.timeoutMs;
  report.cells[0] = finish(box, original);
  const before = JSON.stringify(report);
  validateReport(report); validateArchive(report);
  expect(JSON.stringify(report)).toBe(before);
  original.phases[0]!.timeoutMs = 90_000;
  expect(() => validateReport(report)).toThrow("Phase timeout differs");
});
test("malformed calibrated policy cannot silently use framework defaults", () => {
  const policy = campaignDeadlines();
  if (!policy.cellTimeouts) throw new Error("Missing fixture cell map");
  delete policy.cellTimeouts["next/chrome/browser"];
  expect(() => validateDeadlines(policy)).toThrow("full inventory");
  expect(() => cellDeadlines(policy, inventory()[0]!)).toThrow("Missing cell");
});
async function scratch(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-cell-policy-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("real resume rejects changed cell limits or frozen provenance without mutating saved evidence", async () => {
  await scratch(async root => {
    const site = join(root, "site"), output = join(root, "report"), sourceFile = join(root, "source.json");
    await mkdir(site);
    const config = options(["--asset-source=fixture", `--root=${site}`, `--output=${output}`]);
    const report = await initialReport(config);
    report.source.dirty = false;
    await writeFile(sourceFile, JSON.stringify(report.source));
    await saveReport(output, report);
    expect((await initialReport({ ...config, resume: true, sourceFile })).deadlines).toEqual(report.deadlines);
    if (!report.deadlines.cellTimeouts || !report.deadlines.calibration) throw new Error("Missing calibration");
    report.deadlines.cellTimeouts["next/chrome/browser"]!.buildTimeoutMs++;
    await saveReport(output, report);
    const before = await readFile(join(output, "TABLE.json"), "utf8");
    await expect(initialReport({ ...config, resume: true, sourceFile })).rejects.toThrow("same effective deadline policy");
    expect(await readFile(join(output, "TABLE.json"), "utf8")).toBe(before);
    report.deadlines = campaignDeadlines(); report.deadlines.calibration!.source.sha256 = "0".repeat(64);
    await saveReport(output, report);
    await expect(initialReport({ ...config, resume: true, sourceFile })).rejects.toThrow("same effective deadline policy");
  });
});
test("metadata staging changes only future campaign metadata and the deadline section, leaving source, outcomes and original budgets intact", async () => {
  const original = JSON.stringify({ ...input(), deadlines: deadlinePolicy(), command: "original command" });
  const updated = JSON.parse(policyMetadata(original));
  expect(updated.campaignPolicy).toEqual(campaignDeadlines());
  delete updated.campaignPolicy;
  expect(updated).toEqual(JSON.parse(original));
  const markdown = "# Original\n\n## Deadlines\n\nOld limits\n\n## Chrome\n\nOriginal outcomes\n";
  expect(policyMarkdown(markdown)).toStartWith("# Original\n\n## Deadlines\n");
  expect(policyMarkdown(markdown)).toEndWith("## Chrome\n\nOriginal outcomes\n");
  await scratch(async root => {
    await writeFile(join(root, "TABLE.json"), original); await writeFile(join(root, "VIEW.json"), original); await writeFile(join(root, "TABLE.md"), markdown);
    await stagePolicyMetadata(root, join(root, "stage"));
    expect(await readFile(join(root, "TABLE.json"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(join(root, "stage/metadata-update.json"), "utf8"))).toMatchObject({ before: { "TABLE.json": sha256(original), "TABLE.md": sha256(markdown) } });
    await expect(stagePolicyMetadata(root, root)).rejects.toThrow("never overwrite");
  });
});
