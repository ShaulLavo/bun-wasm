import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { checkPageReady } from "../web/tests/async-context-runtime-page.ts";
import assert from "node:assert/strict";

const fixture = resolve(import.meta.dir, "../tests/async-context-runtime/index.ts");

function reportFrom(output: string): unknown {
  const line = output.split("\n").find(value => value.startsWith("CTX01_RESULT "));
  assert.ok(line, output);
  return JSON.parse(line.slice("CTX01_RESULT ".length));
}

test("Node reference keeps ALS across runtime-generated code", () => {
  const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fixture], { encoding: "utf8", timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const report = reportFrom(result.stdout);
  checkPageReady(report, "Node reference");
  expect(report.status).toBe("pass");
  expect(report.failures).toEqual([]);
  expect(report.origins).toHaveLength(12);
  expect(report.observations).toHaveLength(292);
});

function referenceReport() {
  const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fixture], { encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
  const report = reportFrom(result.stdout);
  checkPageReady(report, "Node reference");
  return report;
}

test("reference report stays outside the default comparison-fixture discovery", () => {
  const root = resolve(import.meta.dir, "..");
  const script = readFileSync(resolve(root, "scripts/test.sh"), "utf8");
  const start = script.indexOf("if [[ ${#names[@]} == 0 ]]; then");
  expect(start).toBeGreaterThanOrEqual(0);
  const selection = script.slice(start, script.indexOf("\nfi", start) + 3);
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", 'root="$1"; names=(); ' + selection + '\nprintf "%s\\n" "${names[@]}"', "fixture-discovery", root], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.split("\n")).not.toContain("async-context-runtime");
});

for (const phase of ["catch", "finally", "nested"]) {
  test(`browser validator rejects missing ${phase} observations`, () => {
    const report = referenceReport();
    report.observations = report.observations.filter(entry => !entry.phase.includes(phase));
    expect(() => checkPageReady(report, "missing phase control")).toThrow();
  });
}

test("browser validator rejects a missing request's observations", () => {
  const report = referenceReport();
  report.observations = report.observations.filter(entry => entry.request !== "request-B");
  expect(() => checkPageReady(report, "missing request control")).toThrow();
});

test("browser validator rejects a substituted origin even when the count is unchanged", () => {
  const report = referenceReport();
  const origin = report.origins.find(entry => entry.kind === "eval");
  assert.ok(origin);
  report.origins = report.origins.slice(1).concat([origin]);
  expect(() => checkPageReady(report, "missing origin control")).toThrow();
});

test("fixture rejects fulfilled Promise.reject and missing catch observations", () => {
  const override = "data:text/javascript,Promise.reject=function(reason){return Promise.resolve(reason)}";
  const result = spawnSync("node", ["--import", override, "--disable-warning=ExperimentalWarning", fixture], { encoding: "utf8", timeout: 30_000 });
  const report = reportFrom(result.stdout);
  expect(result.status).toBe(1);
  assert.ok(report && typeof report === "object" && "status" in report);
  expect(report.status).toBe("fail");
  expect(JSON.stringify(report)).toContain("expected rejection fulfilled");
  expect(() => checkPageReady(report, "fulfilled rejection control")).toThrow();
});

test("fixture validates rejection identity rather than accepting an error with the same message", () => {
  const override = "data:text/javascript,Promise.reject=function(reason){return new Promise((resolve,reject)=>reject(new Error(reason.message)))}";
  const result = spawnSync("node", ["--import", override, "--disable-warning=ExperimentalWarning", fixture], { encoding: "utf8", timeout: 30_000 });
  const report = reportFrom(result.stdout);
  expect(result.status).toBe(1);
  expect(() => checkPageReady(report, "wrong rejection marker control")).toThrow();
});

for (const field of ["expected", "actual"] as const) {
  test(`validator rejects a forged ${field} store despite a true success flag`, () => {
    const report = referenceReport();
    const entry = report.observations.find(value => value.request === "request-B");
    assert.ok(entry);
    entry[field] = "request-A";
    expect(() => checkPageReady(report, "forged store control")).toThrow();
  });
}

test("validator rejects a duplicate observation replacing a required phase", () => {
  const report = referenceReport();
  const duplicate = report.observations.find(value => value.phase === "run.enter" && value.request === "request-B");
  assert.ok(duplicate);
  report.observations = report.observations.slice(1).concat([duplicate]);
  expect(() => checkPageReady(report, "duplicate observation control")).toThrow();
});
