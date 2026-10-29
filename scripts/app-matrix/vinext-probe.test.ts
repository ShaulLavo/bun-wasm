import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { selectChecks } from "../test-checks";

const expectedStages = ["install", "dev", "dev:page", "dev:hmr", "dev:reload", "dev:counter", "build", "start"];
function readReport(path: string) {
  const report: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!report || typeof report !== "object" || !("rows" in report) || !Array.isArray(report.rows)) throw new Error("Invalid report rows");
  const rows = report.rows.map((row: unknown) => {
    if (!row || typeof row !== "object" || !("stage" in row) || !("status" in row)) throw new Error("Invalid result row");
    if (typeof row.stage !== "string" || typeof row.status !== "string") throw new Error("Invalid result identity");
    return { stage: row.stage, status: row.status };
  });
  return { report, rows };
}
function control(scenario: string, verify: (value: ReturnType<typeof readReport>, closed: boolean, status: number | null) => void) {
  const directory = mkdtempSync("/work/tmp/bun-wasm-vinext-regression-");
  try {
    const child = spawnSync(process.execPath, [resolve(import.meta.dir, "../fixtures/vinext-probe-control.ts"), directory, scenario], { encoding: "utf8", timeout: 15000 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    const value = readReport(join(directory, "output/run.json"));
    expect(value.rows.filter(row => expectedStages.includes(row.stage)).map(row => row.stage)).toEqual(expectedStages);
    expect(value.report).toHaveProperty("cleanup", "pass");
    expect(value.report).toHaveProperty("runtime.canonical", false);
    verify(value, existsSync(join(directory, "host-closed")), child.status);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function expectUnrun(rows: ReturnType<typeof readReport>["rows"]) {
  for (const stage of expectedStages.filter(stage => stage !== "install")) expect(rows.find(row => row.stage === stage)?.status).toBe("blocked");
}

test("vinext reporting regressions belong to the discovered quality gate", () => {
  expect(selectChecks("quality")).toContain("scripts/app-matrix/vinext-probe.test.ts");
});
test("missing assets finalize a nonempty failure report with every app cell blocked", () => {
  control("missing", ({ report, rows }, _closed, status) => {
    expect(status).toBe(1);
    expect(rows.some(row => row.status === "fail")).toBe(true);
    for (const stage of expectedStages) expect(rows.find(row => row.stage === stage)?.status).toBe("blocked");
    expect(report).toHaveProperty("infrastructureError", expect.stringContaining("ENOENT"));
  });
});
for (const scenario of ["after-install", "signal"]) test(`${scenario} preserves install and finalizes unrun cells after cleanup`, () => {
  control(scenario, ({ rows, report }, closed, status) => {
    expect(status).toBe(scenario === "signal" ? 130 : 1);
    expect(rows.find(row => row.stage === "install")?.status).toBe("pass");
    expectUnrun(rows);
    expect(rows.some(row => row.status === "fail")).toBe(true);
    expect(report).toHaveProperty("infrastructureError", expect.stringContaining(scenario === "signal" ? "SIGTERM" : "injected"));
    expect(closed).toBe(true);
  });
});
test("conflicting plain and gzip payloads fail before any app can pass", () => {
  control("mismatch", ({ report, rows }, _closed, status) => {
    expect(status).toBe(1);
    expect(report).toHaveProperty("infrastructureError", expect.stringContaining("payload mismatch"));
    for (const stage of expectedStages) expect(rows.find(row => row.stage === stage)?.status).toBe("blocked");
  });
});
for (const scenario of ["matching", "plain-only", "gzip-only"]) test(`${scenario} reports the loaded payload digest without claiming guest acceptance`, () => {
  control(scenario, ({ report, rows }, closed, status) => {
    const digest = createHash("sha256").update("probe payload").digest("hex");
    expect(status).toBe(0);
    expect(report).toHaveProperty(["runtime", "assets", "bun.wasm"], digest);
    expect(report).toHaveProperty(["runtime", "assets", "quickjs.wasm"], digest);
    expect(rows.every(row => row.status === "pass")).toBe(true);
    expect(closed).toBe(true);
  });
});
