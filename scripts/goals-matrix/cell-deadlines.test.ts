import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reviewed from "./cell-deadlines.json";
import { defaultCellPolicy, hangCaps } from "./generate-deadlines";
import { contentHash as sha256 } from "./policy-publication";
import { campaignDeadlines, cellDeadlines, deadlinePolicy, sameDeadlines, validateDeadlines } from "./deadlines";
import { inventory, boxId, type Box } from "./catalog";
import { completeAttempt } from "./test-fixture";
import { initialCells, finish, validateReport, type Attempt, type Report } from "./model";
import { initialReport, options } from "./run";
import { nativeRunnerArgs } from "./fleet";
import { deadlineMarkdown, saveReport } from "./report";
import { authoritativePolicy, policyMetadata, policyMarkdown, stagePolicyMetadata } from "./policy-metadata";
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
test("all 208 cells use the same hang caps, independent of earlier measurements", () => {
  expect(reviewed).toEqual(defaultCellPolicy());
  expect(reviewed.cells).toHaveLength(208);
  const policy = campaignDeadlines();
  for (const box of inventory()) expect(cellDeadlines(policy, box)).toEqual(hangCaps);
  expect(policy.cleanupTimeoutMs).toBe(20_000);
  expect(validateDeadlines(policy)).toEqual(policy);
});
test("hang cap metadata makes no measurement or margin claim", () => {
  expect(reviewed.metadata).toMatchObject({ kind: "hang-caps", decisionDate: "2026-11-14" });
  expect(reviewed.metadata).not.toHaveProperty("margin");
  expect(reviewed.metadata).not.toHaveProperty("source");
  const markdown = deadlineMarkdown(campaignDeadlines());
  expect(markdown).toContain("2026-11-14");
  expect(markdown).toContain("Actual phase times remain recorded");
  expect(markdown).toContain("| Next.js | chrome | browser | 300000 | 600000 | 600000 |");
  expect(markdown).not.toContain("12.5%");
  expect(markdown).not.toContain("exempt");
});
test("changing a returned policy cannot change future campaign defaults", () => {
  const changed = campaignDeadlines();
  changed.calibration.decision = "changed metadata";
  changed.cellTimeouts["next/chrome/browser"]!.buildTimeoutMs = 999_999;
  expect(cellDeadlines(campaignDeadlines(), inventory()[0]!)).toEqual(hangCaps);
  expect(campaignDeadlines().calibration).toEqual(defaultCellPolicy().metadata);
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
test("historical calibrated reports retain independent build bounds, metadata and elapsed times", () => {
  const box = inventory()[0]!;
  const deadlines = validateDeadlines({ ...deadlinePolicy(90_000), buildTimeouts: { ...deadlinePolicy(90_000).buildTimeouts, next: 110_000 },
    calibration: { decision: "Historical calibration", decisionDate: "2026-11-11", margin: 0.125, selection: "Latest complete pass",
      source: { path: "historical/TABLE.json", sha256: "a".repeat(64), run: "historical", createdAt: "2026-11-11T20:00:00Z" } },
    cellTimeouts: Object.fromEntries(inventory().map(cell => [boxId(cell), { timeoutMs: 90_000, installTimeoutMs: 90_000, buildTimeoutMs: cell.framework === "next" ? 110_000 : 90_000 }])),
    overrides: { timeoutMs: null, installTimeouts: {} } });
  const original = attempt(box, date), limits = cellDeadlines(deadlines, box);
  for (const phase of original.phases) phase.timeoutMs = phase.phase === "cleanup" ? 20_000 : phase.phase === "build" ? limits.buildTimeoutMs : limits.timeoutMs;
  const report: Report = { ...input(), schema: 2, command: "historical", deadlines };
  report.cells[0] = finish(box, original);
  const before = JSON.stringify(report);
  validateReport(report); validateArchive(report);
  expect(JSON.stringify(report)).toBe(before);
  expect(original.phases.find(phase => phase.phase === "build")).toMatchObject({ durationMs: 3000, timeoutMs: 110_000 });
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
test("real resume rejects changed cell limits or policy metadata without mutating saved evidence", async () => {
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
    report.deadlines = campaignDeadlines(); report.deadlines.calibration!.decision = "different policy provenance";
    await saveReport(output, report);
    await expect(initialReport({ ...config, resume: true, sourceFile })).rejects.toThrow("same effective deadline policy");
  });
});
test("metadata staging changes only future campaign metadata and the deadline section, leaving source, outcomes and original budgets intact", async () => {
  const original = JSON.stringify({ ...input(), deadlines: deadlinePolicy(), command: "original command" });
  const authority = { schema: 1, ownerDecisions: [{ framework: "next", engine: "spidermonkey", activeLimitMs: 110_000 }] };
  const policy = authoritativePolicy(authority, undefined);
  const updated = JSON.parse(policyMetadata(original, policy));
  expect(updated.campaignPolicy).toEqual({ ...authority, cellDeadlines: campaignDeadlines() });
  delete updated.campaignPolicy;
  expect(updated).toEqual(JSON.parse(original));
  const markdown = "# Original\n\n## Deadlines\n\nOld limits\n\n## Chrome\n\nOriginal outcomes\n";
  expect(policyMarkdown(markdown)).toStartWith("# Original\n\n## Deadlines\n");
  expect(policyMarkdown(markdown)).toEndWith("## Chrome\n\nOriginal outcomes\n");
  await scratch(async root => {
    await writeFile(join(root, "TABLE.json"), original); await writeFile(join(root, "VIEW.json"), original); await writeFile(join(root, "TABLE.md"), markdown);
    await writeFile(join(root, "CAMPAIGN-POLICY.json"), JSON.stringify(authority));
    await stagePolicyMetadata(root, join(root, "stage"));
    expect(await readFile(join(root, "TABLE.json"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(join(root, "stage/metadata-update.json"), "utf8"))).toMatchObject({ before: { "TABLE.json": sha256(original), "TABLE.md": sha256(markdown) } });
    await expect(stagePolicyMetadata(root, root)).rejects.toThrow("never overwrite");
  });
});
