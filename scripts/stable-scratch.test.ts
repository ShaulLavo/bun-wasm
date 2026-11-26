import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableScratch } from "./stable-scratch.ts";

const originalRunnerTemp = process.env.RUNNER_TEMP;
const originalActions = process.env.GITHUB_ACTIONS;
const cleanup: string[] = [];

function restore(name: "RUNNER_TEMP" | "GITHUB_ACTIONS", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("RUNNER_TEMP", originalRunnerTemp);
  restore("GITHUB_ACTIONS", originalActions);
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function expectSeparateRuns(): void {
  const first = stableScratch("concurrent-control");
  const second = stableScratch("concurrent-control");
  cleanup.push(first, second);
  expect(second).not.toBe(first);
  // The second run's setup must not delete what the first run already built.
  writeFileSync(join(first, "target-marker"), "built");
  const third = stableScratch("concurrent-control");
  cleanup.push(third);
  expect(readFileSync(join(first, "target-marker"), "utf8")).toBe("built");
  expect(existsSync(join(second, "target-marker"))).toBe(false);
}

test("outside CI, two runs of the same check get separate scratch directories", () => {
  delete process.env.RUNNER_TEMP;
  delete process.env.GITHUB_ACTIONS;
  expectSeparateRuns();
  expect(stableScratch("under-tmpdir").startsWith(tmpdir())).toBe(true);
});

test("a RUNNER_TEMP exported on a developer machine does not bring the collision back", () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "bun-wasm-stable-scratch-control-"));
  cleanup.push(runnerTemp);
  process.env.RUNNER_TEMP = runnerTemp;
  delete process.env.GITHUB_ACTIONS;
  expectSeparateRuns();
});

test("in GitHub Actions, the scratch path stays fixed per check name so sccache keeps hitting", () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "bun-wasm-stable-scratch-control-"));
  cleanup.push(runnerTemp);
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.GITHUB_ACTIONS = "true";
  const first = stableScratch("ci-control");
  writeFileSync(join(first, "stale"), "left over");
  const second = stableScratch("ci-control");
  expect(second).toBe(first);
  expect(first).toBe(join(runnerTemp, "bun-wasm-stable-scratch", "ci-control"));
  expect(existsSync(join(second, "stale"))).toBe(false);
});

test("scratch names are restricted", () => {
  expect(() => stableScratch("../escape")).toThrow("Invalid stable scratch name");
});
