import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = object(workflow.jobs);
const browser = object(jobs.web);
const unit = object(jobs["web-unit"]);

function steps(job: Record<string, unknown>) {
  assert(Array.isArray(job.steps));
  return job.steps.map(object);
}

test("unit and browser phases run once in separate ten-minute jobs", () => {
  expect(browser.name).toBe("Web host");
  expect(browser.needs).toEqual(["quality", "web-unit"]);
  expect(unit.needs).toBe("quality");
  const all = Object.values(jobs).flatMap(job => steps(object(job)));
  for (const phase of ["unit", "browser", "setup"]) {
    expect(all.filter(step => step.run === `bash ../scripts/test-web-host.sh --${phase}`)).toHaveLength(1);
  }
  for (const job of [unit, browser]) {
    expect(job["timeout-minutes"]).toBe(10);
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job).not.toHaveProperty("continue-on-error");
  }
  expect(JSON.stringify(unit)).not.toContain("playwright install");
  expect(JSON.stringify(browser)).not.toContain("rust-toolchain@");
});

test.each(["success", "failure", "cancelled", "skipped", ""])("required Web host gate rejects a non-successful unit result: %s", result => {
  assert(typeof browser.if === "string");
  expect(browser.if).toContain("always()");
  const condition = browser.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("always()", "true")
    .replaceAll("needs.quality.result", JSON.stringify("success"))
    .replaceAll("github.event_name", JSON.stringify("pull_request"))
    .replaceAll("github.event.pull_request.draft", "false");
  expect(new Function(`return (${condition})`)()).toBe(true);
  const entries = steps(browser);
  const guard = entries.find(step => step.name === "Require all Web host unit gates");
  assert(guard && typeof guard.run === "string");
  expect(object(guard.env).WEB_UNIT_RESULT).toBe("${{ needs.web-unit.result }}");
  expect(guard).not.toHaveProperty("if");
  expect(guard).not.toHaveProperty("continue-on-error");
  const execution = spawnSync("bash", ["-euc", guard.run], { env: { ...process.env, WEB_UNIT_RESULT: result } });
  expect(execution.error).toBeUndefined();
  expect(execution.status).toBe(result === "success" ? 0 : 1);
  expect(entries.indexOf(guard)).toBeLessThan(entries.findIndex(step => step.uses === "./.github/actions/release-downloads"));
});

test("both Web jobs reuse the existing release namespace and browser setup is isolated", () => {
  for (const job of [unit, browser]) {
    const restore = steps(job).find(step => step.uses === "./.github/actions/release-downloads");
    expect(object(restore?.with).scope).toBe("web");
    expect(steps(job).filter(step => step.uses === "./.github/actions/save-release-downloads")).toHaveLength(1);
  }
  const entries = steps(browser);
  const setup = entries.findIndex(step => step.run === "bash ../scripts/test-web-host.sh --setup");
  const packages = entries.findIndex(step => step.uses === "./.github/actions/browser-deps");
  const engines = entries.findIndex(step => step.run === "bunx playwright install chromium firefox webkit");
  const tests = entries.findIndex(step => step.run === "bash ../scripts/test-web-host.sh --browser");
  expect(setup).toBeGreaterThan(0);
  expect(packages).toBeGreaterThan(setup);
  expect(engines).toBeGreaterThan(packages);
  expect(tests).toBeGreaterThan(engines);
});
