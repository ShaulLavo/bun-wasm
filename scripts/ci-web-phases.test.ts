import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, setDefaultTimeout, test } from "bun:test";
import { automaticChecks, discoverChecks, namedCheckBatches, parseCheck, selectCheckBatch, selectChecks } from "./test-checks";
import { webBrowserShards } from "./ci-web-browser-shards";
import { needsRust } from "./ci-changes";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = object(workflow.jobs);
const browser = object(jobs["web-browser"]);
const unit = object(jobs["web-unit"]);

function steps(job: Record<string, unknown>) {
  assert(Array.isArray(job.steps));
  return job.steps.map(object);
}

test("a package exact-exec fixture-only edit retains its blocking Web unit owner", () => {
  const fixture = "tests/package/fixtures/engine-host-exec.ts";
  const owner = "web/tests/bun-executor.test.ts";
  expect(needsRust([fixture])).toBe(false);
  const pullRequest = object(object(workflow.on).pull_request);
  expect(pullRequest).not.toHaveProperty("paths");
  expect(pullRequest).not.toHaveProperty("paths-ignore");
  expect(unit.needs).toBe("selection");
  expect(unit.if).toBe("${{ (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}");
  expect(unit).not.toHaveProperty("continue-on-error");
  expect(steps(unit).filter(step => step.run === "bash ../scripts/test-web-host.sh --unit")).toHaveLength(1);
  expect(readFileSync(new URL("./test-web-host.sh", import.meta.url), "utf8")).toContain("bun run test");
  expect(automaticChecks().filter(check => check.path === owner)).toEqual([{ owner: "web", path: owner }]);
  expect(readFileSync(new URL("../web/tests/bun-executor.test.ts", import.meta.url), "utf8")).toContain('import("../../tests/package/fixtures/engine-host-exec.ts")');
});

test("unit and consolidated browser jobs remain blocking without Playwright in unit checks", () => {
  expect(browser.name).toBe("Web browser");
  expect(browser.needs).toBe("selection");
  expect(unit.needs).toBe("selection");
  const all = Object.values(jobs).flatMap(job => steps(object(job)));
  expect(all.filter(step => step.run === "bash ../scripts/test-web-host.sh --unit")).toHaveLength(1);
  expect(all.filter(step => step.run === "bash ../scripts/test-web-host.sh --setup")).toHaveLength(1);
  expect(all.filter(step => step.run === "bun ../scripts/ci-web-browser-run.ts")).toHaveLength(1);
  expect(unit["timeout-minutes"]).toBe(10);
  expect(browser["timeout-minutes"]).toBe(15);
  for (const job of [unit, browser]) {
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job).not.toHaveProperty("continue-on-error");
  }
  expect(JSON.stringify(unit)).not.toContain("playwright install");
  expect(JSON.stringify(browser)).not.toContain("rust-toolchain@");
});

test("Web jobs reuse the existing release namespace and browser setup is isolated", () => {
  for (const job of [unit, browser]) {
    const restore = steps(job).find(step => step.uses === "./.github/actions/release-downloads");
    expect(object(restore?.with).scope).toBe("web");
    expect(steps(job).filter(step => step.uses === "./.github/actions/save-release-downloads")).toHaveLength(1);
  }
  const entries = steps(browser);
  const setup = entries.findIndex(step => step.run === "bash ../scripts/test-web-host.sh --setup");
  const packages = entries.findIndex(step => step.uses === "./.github/actions/browser-deps");
  const engines = entries.findIndex(step => step.run === "bunx playwright install chromium firefox webkit");
  const tests = entries.findIndex(step => step.run === "bun ../scripts/ci-web-browser-run.ts");
  expect(setup).toBeGreaterThan(0);
  expect(packages).toBeGreaterThan(setup);
  expect(engines).toBeGreaterThan(packages);
  expect(tests).toBeGreaterThan(engines);
});

test("browser shards cover all four batches and the consolidated runner executes smoke and process gates", () => {
  const selected = namedCheckBatches("web-browser");
  const matrix = webBrowserShards(selected);
  expect(matrix).toContainEqual({ batch: "10-interface", pairedBatch: "21-preview-navigation", timeoutSeconds: 300 });
  expect(matrix).toContainEqual({ batch: "20-preview", pairedBatch: "30-lifecycle", timeoutSeconds: 300 });
  const names = matrix.flatMap(shard => [shard.batch, shard.pairedBatch].filter(Boolean));
  expect(names.toSorted()).toEqual(selected.map(batch => batch.name));
  const paths = names.flatMap(name => selectCheckBatch("web-browser", name));
  expect(paths.toSorted()).toEqual(selectChecks("web-browser"));
  expect(new Set(paths).size).toBe(paths.length);
  const runner = readFileSync(new URL("./ci-web-browser-run.ts", import.meta.url), "utf8");
  expect(runner).toContain("webBrowserShards()");
  expect(runner).toContain("--smoke");
  expect(runner).toContain("tests/browser-process.ts");
  expect(runner).toContain("tests/browser-interrupt.ts");
  expect(runner).toContain("tests/browser-runtime-proc.ts");
  const execution = spawnSync("bun", [new URL("./ci-web-browser-shards.ts", import.meta.url).pathname], { encoding: "utf8" });
  expect(execution.status, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({ include: matrix });
});

test("new, default and unpaired browser batches still get scheduled by webBrowserShards", () => {
  const checks = discoverChecks().concat([
    parseCheck({ owner: "web-browser", path: "scripts/new-browser.test.ts", batch: "40-new" }, "web-browser-new.json"),
    parseCheck({ owner: "web-browser", path: "scripts/default-browser.test.ts" }, "web-browser-default.json"),
  ]);
  const selected = namedCheckBatches("web-browser", checks);
  const matrix = webBrowserShards(selected);
  expect(matrix).toContainEqual({ batch: "40-new", pairedBatch: "", timeoutSeconds: 300 });
  expect(matrix).toContainEqual({ batch: "default", pairedBatch: "", timeoutSeconds: 300 });
  expect(webBrowserShards(selected.filter(batch => batch.name === "30-lifecycle"))).toEqual([
    { batch: "30-lifecycle", pairedBatch: "", timeoutSeconds: 300 },
  ]);
  const names = matrix.flatMap(shard => [shard.batch, shard.pairedBatch].filter(Boolean));
  const paths = names.flatMap(name => selectCheckBatch("web-browser", name, checks));
  expect(paths.toSorted()).toEqual(selectChecks("web-browser", checks).toSorted());
  expect(new Set(paths).size).toBe(paths.length);
});
