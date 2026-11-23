import { expect, test } from "bun:test";
import type { Phase, PhaseResult } from "./goals-matrix/model";
import { smokeCases } from "./iphone-smoke/cases";
import { chromeCells, liveSmokeOptions, overallStatus, parseDeployment, phaseSummary, smokeGreen } from "./chrome-live-smoke";

function result(phase: Phase, status: "pass" | "fail"): PhaseResult {
  const common = { phase, startedAt: "2026-11-23T00:00:00.000Z", durationMs: 1, timeoutMs: 1000 };
  return status === "pass" ? { ...common, status, evidence: null } : { ...common, status, error: "fixture failure" };
}

const judged: Phase[] = ["startup", "install", "dev", "render", "click"];

test("options default to the owner's sandbox and resolve the output directory", () => {
  const options = liveSmokeOptions(["--output=out"]);
  expect(options.base.href).toBe("https://bun.sprockt.dev/");
  expect(options.output).toBe(`${process.cwd()}/out`);
  expect(options.timeoutMs).toBe(300_000);
  expect(options.installTimeoutMs).toBe(600_000);
  const custom = liveSmokeOptions(["--output", "/tmp/x", "--base-url", "http://127.0.0.1:4173/", "--timeout-ms=1000"]);
  expect(custom.base.href).toBe("http://127.0.0.1:4173/");
  expect(custom.timeoutMs).toBe(1000);
});

test("options reject a missing output, unknown flags, bad URLs and bad limits", () => {
  expect(() => liveSmokeOptions([])).toThrow("Usage");
  expect(() => liveSmokeOptions(["--output=x", "--verbose"])).toThrow();
  expect(() => liveSmokeOptions(["--output=x", "positional"])).toThrow();
  expect(() => liveSmokeOptions(["--output=x", "--base-url=ftp://example.test/"])).toThrow("http(s)");
  expect(() => liveSmokeOptions(["--output=x", "--base-url=not a url"])).toThrow();
  for (const value of ["0", "-5", "1.5", "soon"]) expect(() => liveSmokeOptions(["--output=x", `--timeout-ms=${value}`])).toThrow("positive integer");
});

test("cells mirror the iPhone smoke in Chrome", () => {
  const cells = chromeCells();
  expect(cells.map(cell => cell.browser)).toEqual(["chrome", "chrome", "chrome"]);
  expect(cells.map(({ framework, engine }) => ({ framework, engine }))).toEqual(smokeCases.map(({ framework, engine }) => ({ framework, engine })));
});

test("the verdict judges the smoke phases and cleanup, never later phases", () => {
  const green = judged.map(phase => result(phase, "pass")).concat([result("hot-reload", "fail"), result("cleanup", "pass")]);
  expect(smokeGreen(green)).toBe(true);
  expect(phaseSummary(green)).toBe("startup:pass install:pass dev:pass render:pass click:pass hot-reload:fail cleanup:pass");
  expect(smokeGreen(judged.map(phase => result(phase, "pass")))).toBe(false);
  expect(smokeGreen(judged.map(phase => result(phase, phase === "render" ? "fail" : "pass")).concat([result("cleanup", "pass")]))).toBe(false);
  expect(smokeGreen(judged.map(phase => result(phase, "pass")).concat([result("cleanup", "fail")]))).toBe(false);
  expect(smokeGreen([])).toBe(false);
});

test("the run is green only when every cell is", () => {
  expect(overallStatus([{ smokeGreen: true }, { smokeGreen: true }])).toBe("green");
  expect(overallStatus([{ smokeGreen: true }, { smokeGreen: false }])).toBe("red");
  expect(overallStatus([])).toBe("red");
});

test("deployment records need a source commit and Waffle version", () => {
  expect(parseDeployment({ sourceCommit: "d8cab52a", waffleVersion: "0.0.146", templates: [] })).toEqual({ sourceCommit: "d8cab52a", waffleVersion: "0.0.146" });
  expect(() => parseDeployment(null)).toThrow("not an object");
  expect(() => parseDeployment({ sourceCommit: "d8cab52a" })).toThrow("waffleVersion");
});
