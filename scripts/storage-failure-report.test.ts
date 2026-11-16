import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoragePreservationFailure } from "../sandbox/tests/storage-browser";
import { reportStorageFailure } from "./storage-failure-report";
import firefoxProtocol from "./fixtures/storage-ci/firefox.json";
import webkitProtocol from "./fixtures/storage-ci/webkit.json";
import webkitReactProtocols from "./fixtures/storage-ci/webkit-react.json";
import webkitRestorationProtocol from "./fixtures/storage-ci/webkit-restoration.json";
import { discoverChecks } from "./test-checks";
import { needsJsc, needsRust } from "./ci-changes";

type Report = StoragePreservationFailure["report"];
type HistoricalFailure = { label: string; browser: string; report: Report };
const vanillaHistory: HistoricalFailure[] = [
  { label: "Firefox Vue CLOSED", browser: "firefox", report: { ...firefoxProtocol, checkpoint: "first-vite-vue-startup" } },
  { label: "WebKit config restart", browser: "webkit", report: { ...webkitProtocol, checkpoint: "vanilla-config-restart" } },
  { label: "WebKit first restoration", browser: "webkit", report: { ...webkitRestorationProtocol, checkpoint: "first-vanilla-restoration" } },
];
const history = vanillaHistory.concat(webkitReactProtocols.map((record): HistoricalFailure => ({ label: `WebKit React job ${record.source.job}`, browser: "webkit",
  report: { ...record.report, checkpoint: "first-vite-react-startup" } })));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function evidence(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-storage-report-"));
  directories.push(directory);
  return { CI: "true", BUN_WASM_BROWSER_REPORT_DIR: directory, GITHUB_STEP_SUMMARY: join(directory, "summary.md") };
}

function failure(report: Report): StoragePreservationFailure {
  return new StoragePreservationFailure(structuredClone(report), new Error(report.error));
}

async function assertReported(browser: string, original: StoragePreservationFailure, env: NodeJS.ProcessEnv): Promise<void> {
  const summary = "Existing job summary\n";
  await writeFile(env.GITHUB_STEP_SUMMARY!, summary);
  const warnings = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(reportStorageFailure(browser, original, env)).rejects.toBe(original);
    expect(warnings).not.toHaveBeenCalled();
  } finally { warnings.mockRestore(); }
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, `sandbox-storage-${browser}-preservation.json`), "utf8"));
  expect(saved).toEqual({ browser, ...original.report });
  expect(await readFile(env.GITHUB_STEP_SUMMARY!, "utf8")).toBe(summary);
}

test.each(history)("$label retains complete diagnostics and rejects the identical failure", async ({ browser, report }) => {
  const env = await evidence();
  await assertReported(browser, failure(report), env);
  await assertReported(browser, failure({ ...report, checkpoint: "preservation" }), { ...env, CI: undefined });
});

test("changed controls and unknown output remain complete rejection evidence", async () => {
  const env = await evidence();
  const report = failure(history[2]!.report).report;
  const variants: Partial<Report>[] = [
    { checkpoint: "setup" }, { error: "Error: restored source HMR replaced the document" },
    { errors: report.errors.concat("unknown transport failure") }, { pages: ["closed", "diagnostic evaluation failed"] },
    { pages: report.pages.map(page => typeof page === "string" ? page : { ...page, terminal: `${page.terminal}\nunknown guest output`,
      frames: page.frames.map(frame => ({ ...frame, acceptedDocument: false, body: "unexpected counter" })),
      runtime: page.runtime ? { ...page.runtime, pending: true, filesystem: { status: "failed", error: "CLOSED" } } : null }) },
  ];
  for (const patch of variants) await assertReported("webkit", failure({ ...report, ...patch }), env);
});

test.each(history)("$label still rejects without a report destination or job summary", async ({ browser, report }) => {
  const original = failure(report);
  await expect(reportStorageFailure(browser, original, {})).rejects.toBe(original);
  const env = await evidence();
  await expect(reportStorageFailure(browser, original, { ...env, GITHUB_STEP_SUMMARY: undefined })).rejects.toBe(original);
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, `sandbox-storage-${browser}-preservation.json`), "utf8"));
  expect(saved).toEqual({ browser, ...original.report });
});

test("explicit report paths retain the complete primary report before rejection", async () => {
  const env = await evidence();
  const original = failure(history[1]!.report);
  const base = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "explicit.json");
  await expect(reportStorageFailure("webkit", original, { BUN_WASM_STORAGE_REPORT: base })).rejects.toBe(original);
  expect(JSON.parse(await readFile(base.replace(".json", "-webkit-preservation.json"), "utf8"))).toEqual({ browser: "webkit", ...original.report });
});

test.each(history)("$label cannot pass when diagnostic writing fails", async ({ browser, report }) => {
  const env = await evidence();
  const blocked = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "blocked");
  await writeFile(blocked, "not a directory");
  await expect(reportStorageFailure(browser, failure(report), { ...env, BUN_WASM_BROWSER_REPORT_DIR: blocked })).rejects.toMatchObject({ code: "ENOTDIR" });
});

test("unknown errors and ordinary assertion, receipt and cleanup failures rethrow unchanged", async () => {
  const env = await evidence();
  const errors: unknown[] = [new Error("receipt mismatch"), new Error("cleanup failed"), new Error("unsupported user symlink was destroyed"),
    new Error("active workspace was evicted"), { message: "unclassified failure" }, "failure", null, undefined];
  for (const error of errors) await expect(reportStorageFailure("firefox", error, env)).rejects.toBe(error);
  await expect(readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-firefox-preservation.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("reporting and every historical fixture retain the blocking storage and quality owners", () => {
  const checks = discoverChecks();
  expect(checks.find(check => check.path === "scripts/storage-failure-report.test.ts")?.owner).toBe("quality");
  const storage = checks.find(check => check.path === "scripts/sandbox-storage-browser.test.ts");
  expect(storage?.owner).toBe("browser-guest");
  const inputs = ["scripts/storage-failure-report.ts", "scripts/fixtures/storage-ci/firefox.json", "scripts/fixtures/storage-ci/webkit.json",
    "scripts/fixtures/storage-ci/webkit-react.json", "scripts/fixtures/storage-ci/webkit-restoration.json"];
  for (const input of inputs) {
    expect(storage?.inputs).toContain(input);
    expect(needsRust([input])).toBe(true);
    expect(needsJsc([input])).toBe(false);
  }
});
