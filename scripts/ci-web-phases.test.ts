import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { namedCheckBatches, selectCheckBatch, selectChecks } from "./test-checks";
import { webBrowserShards } from "./ci-web-browser-shards";

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = object(workflow.jobs);
const browser = object(jobs.web);
const shards = object(jobs["web-browser"]);
const unit = object(jobs["web-unit"]);

function steps(job: Record<string, unknown>) {
  assert(Array.isArray(job.steps));
  return job.steps.map(object);
}

test("unit, discovered browser shards and smoke checks retain separate blocking jobs", () => {
  expect(browser.name).toBe("Web host");
  expect(browser.needs).toEqual(["quality", "web-unit", "web-browser"]);
  expect(shards.needs).toBe("quality");
  expect(unit.needs).toBe("quality");
  const all = Object.values(jobs).flatMap(job => steps(object(job)));
  for (const phase of ["unit", "smoke"]) {
    expect(all.filter(step => step.run === `bash ../scripts/test-web-host.sh --${phase}`)).toHaveLength(1);
  }
  expect(all.filter(step => step.run === "bash ../scripts/test-web-host.sh --setup")).toHaveLength(2);
  expect(all.filter(step => step.run === "bash ../scripts/test-web-host.sh --browser")).toHaveLength(0);
  for (const job of [unit, browser, shards]) {
    expect(job["timeout-minutes"]).toBe(10);
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job).not.toHaveProperty("continue-on-error");
  }
  expect(JSON.stringify(unit)).not.toContain("playwright install");
  expect(JSON.stringify(browser)).not.toContain("rust-toolchain@");
});

test.each(["web-unit", "web-browser"])("required Web host gate rejects every non-successful %s result", id => {
  assert(typeof browser.if === "string");
  expect(browser.if).toContain("always()");
  const condition = browser.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("always()", "true")
    .replaceAll("needs.quality.result", JSON.stringify("success"))
    .replaceAll("github.event_name", JSON.stringify("pull_request"))
    .replaceAll("github.event.pull_request.draft", "false");
  expect(new Function(`return (${condition})`)()).toBe(true);
  const entries = steps(browser);
  const guard = entries.find(step => step.name === "Require all Web host unit and browser gates");
  assert(guard && typeof guard.run === "string");
  expect(object(guard.env).WEB_UNIT_RESULT).toBe("${{ needs.web-unit.result }}");
  expect(object(guard.env).WEB_BROWSER_RESULT).toBe("${{ needs.web-browser.result }}");
  expect(guard).not.toHaveProperty("if");
  expect(guard).not.toHaveProperty("continue-on-error");
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const env = { ...process.env, WEB_UNIT_RESULT: "success", WEB_BROWSER_RESULT: "success" };
    if (id === "web-unit") env.WEB_UNIT_RESULT = result;
    else env.WEB_BROWSER_RESULT = result;
    const execution = spawnSync("bash", ["-euc", guard.run], { env });
    expect(execution.error).toBeUndefined();
    expect(execution.status).toBe(result === "success" ? 0 : 1);
  }
  expect(entries.indexOf(guard)).toBeLessThan(entries.findIndex(step => step.uses === "./.github/actions/release-downloads"));
});

test("Web jobs reuse the existing release namespace and browser setup is isolated", () => {
  for (const job of [unit, browser, shards]) {
    const restore = steps(job).find(step => step.uses === "./.github/actions/release-downloads");
    expect(object(restore?.with).scope).toBe("web");
    expect(steps(job).filter(step => step.uses === "./.github/actions/save-release-downloads")).toHaveLength(1);
  }
  for (const job of [browser, shards]) {
    const entries = steps(job);
    const setup = entries.findIndex(step => step.run === "bash ../scripts/test-web-host.sh --setup");
    const packages = entries.findIndex(step => step.uses === "./.github/actions/browser-deps");
    const engines = entries.findIndex(step => step.run === "bunx playwright install chromium firefox webkit");
    const tests = entries.findIndex(step => step.name === "Run the discovered Web browser shard" || step.run === "bash ../scripts/test-web-host.sh --smoke");
    expect(setup).toBeGreaterThan(0);
    expect(packages).toBeGreaterThan(setup);
    expect(engines).toBeGreaterThan(packages);
    expect(tests).toBeGreaterThan(engines);
  }
});

test("parallel browser shards discover every owned check exactly once and require measured deadlines", () => {
  const selected = namedCheckBatches("web-browser");
  const matrix = webBrowserShards(selected);
  expect(matrix).toHaveLength(3);
  const paths = matrix.flatMap(shard => selectCheckBatch("web-browser", shard.batch));
  expect(paths.toSorted()).toEqual(selectChecks("web-browser"));
  expect(new Set(paths).size).toBe(paths.length);
  for (const shard of matrix) expect(shard.timeoutSeconds).toBeLessThanOrEqual(300);
  expect(() => webBrowserShards(selected.concat([{ name: "default", paths: ["scripts/new-browser.test.ts"] }]))).toThrow("measured deadlines");
  expect(() => webBrowserShards(selected.map(batch => ({ ...batch, name: "unmeasured" })))).toThrow("Unmeasured");
  expect(object(shards.strategy)).toEqual({ "fail-fast": false, matrix: "${{ fromJSON(needs.quality.outputs.web-browser-shards) }}" });
  const discovery = steps(object(jobs.quality)).find(step => step.id === "web-browser-shards");
  assert(discovery && typeof discovery.run === "string");
  expect(discovery.run).toContain("bun scripts/ci-web-browser-shards.ts");
  const execution = spawnSync("bun", ["scripts/ci-web-browser-shards.ts"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  expect(execution.status, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({ include: matrix });
  const command = steps(shards).find(step => step.name === "Run the discovered Web browser shard");
  expect(command?.run).toBe('bun ../scripts/run-with-timeout.mts "$WEB_BROWSER_TIMEOUT_SECONDS" bun ../scripts/test-checks.ts web-browser --batch "$WEB_BROWSER_BATCH"');
  expect(command?.env).toEqual({ EDITOR_SCRATCH_ROOT: "${{ runner.temp }}", WEB_BROWSER_BATCH: "${{ matrix.batch }}", WEB_BROWSER_TIMEOUT_SECONDS: "${{ matrix.timeoutSeconds }}" });
});
