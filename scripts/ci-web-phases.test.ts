import { ciRunner } from "./fixtures/ci-expressions";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { discoverChecks, namedCheckBatches, parseCheck, selectCheckBatch, selectChecks } from "./test-checks";
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
  expect(browser.needs).toEqual(["selection", "web-unit", "web-browser"]);
  expect(shards.needs).toBe("selection");
  expect(unit.needs).toBe("selection");
  const all = Object.values(jobs).flatMap(job => steps(object(job)));
  for (const phase of ["unit", "smoke"]) {
    expect(all.filter(step => step.run === `bash ../scripts/test-web-host.sh --${phase}`)).toHaveLength(1);
  }
  expect(all.filter(step => step.run === "bash ../scripts/test-web-host.sh --setup")).toHaveLength(2);
  expect(all.filter(step => step.run === "bash ../scripts/test-web-host.sh --browser")).toHaveLength(0);
  for (const job of [unit, browser, shards]) {
    expect(job["timeout-minutes"]).toBe(10);
    expect(ciRunner(job["runs-on"])).toEqual(["ubuntu-latest"]);
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
    .replaceAll("cancelled()", "false")
    .replaceAll("needs.selection.result", JSON.stringify("success"))
    .replaceAll("github.event_name", JSON.stringify("pull_request"))
    .replaceAll("github.event.pull_request.draft", "false")
    .replaceAll("github.event.pull_request.head.repo.full_name", '"ShaulLavo/bun-wasm"')
    .replaceAll("github.repository", '"ShaulLavo/bun-wasm"');
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

test("parallel browser shards preserve every owned check under a generous job hang cap", () => {
  const selected = namedCheckBatches("web-browser");
  const matrix = webBrowserShards(selected);
  expect(matrix.map(shard => shard.batch)).toEqual(selected.map(batch => batch.name));
  const paths = matrix.flatMap(shard => selectCheckBatch("web-browser", shard.batch));
  expect(paths.toSorted()).toEqual(selectChecks("web-browser"));
  expect(new Set(paths).size).toBe(paths.length);
  for (const shard of matrix) {
    expect(shard.timeoutSeconds).toBe(300);
    expect(shard.timeoutSeconds).toBeLessThan(Number(shards["timeout-minutes"]) * 60);
  }
  expect(object(shards.strategy)).toEqual({ "fail-fast": false, matrix: "${{ fromJSON(needs.selection.outputs.web-browser-shards) }}" });
  const discovery = steps(object(jobs.selection)).find(step => step.id === "web-browser-shards");
  assert(discovery && typeof discovery.run === "string");
  expect(discovery.run).toContain("bun scripts/ci-web-browser-shards.ts");
  const execution = spawnSync("bun", [new URL("./ci-web-browser-shards.ts", import.meta.url).pathname], { encoding: "utf8" });
  expect(execution.status, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({ include: matrix });
  const command = steps(shards).find(step => step.name === "Run the discovered Web browser shard");
  expect(command?.run).toBe('bun ../scripts/run-with-timeout.mts "$WEB_BROWSER_TIMEOUT_SECONDS" bun ../scripts/test-checks.ts web-browser --batch "$WEB_BROWSER_BATCH"');
  expect(command?.env).toEqual({ EDITOR_SCRATCH_ROOT: "${{ runner.temp }}", WEB_BROWSER_BATCH: "${{ matrix.batch }}", WEB_BROWSER_TIMEOUT_SECONDS: "${{ matrix.timeoutSeconds }}" });
});

test("new browser batches and the default batch need no timing calibration", () => {
  const checks = discoverChecks().concat([
    parseCheck({ owner: "web-browser", path: "scripts/new-browser.test.ts", batch: "40-new" }, "web-browser-new.json"),
    parseCheck({ owner: "web-browser", path: "scripts/default-browser.test.ts" }, "web-browser-default.json"),
  ]);
  const selected = namedCheckBatches("web-browser", checks);
  const matrix = webBrowserShards(selected);
  expect(matrix.map(shard => shard.batch)).toEqual(selected.map(batch => batch.name));
  expect(matrix).toContainEqual({ batch: "40-new", timeoutSeconds: 300 });
  expect(matrix).toContainEqual({ batch: "default", timeoutSeconds: 300 });
  const paths = matrix.flatMap(shard => selectCheckBatch("web-browser", shard.batch, checks));
  expect(paths.toSorted()).toEqual(selectChecks("web-browser", checks).toSorted());
  expect(new Set(paths).size).toBe(paths.length);
});
