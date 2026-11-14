import { expect, test } from "bun:test";
import { campaignDeadlines, cellDeadlines, deadlinePolicy, validateDeadlines, sameDeadlines } from "./deadlines";
import { frameworks } from "./catalog";
import { initialReport, options } from "./run";
import { nativeRunnerArgs } from "./fleet";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("phase overrides leave every framework build at the independent ten minute hang cap", () => {
  const config = options(["--asset-source=unit"]);
  expect(config.timeoutMs).toBeUndefined();
  const policy = deadlinePolicy(90_000);
  for (const framework of frameworks) {
    expect(policy.installTimeouts[framework.id]).toBe(90_000);
    expect(policy.buildTimeouts[framework.id]).toBe(600_000);
  }
  expect(policy.cleanupTimeoutMs).toBe(20_000);
  expect(deadlinePolicy(300_000).buildTimeouts.next).toBe(600_000);
  expect(cellDeadlines(campaignDeadlines(300_000), { framework: "next", browser: "chrome", engine: "browser" }).buildTimeoutMs).toBe(600_000);
});

test("reports require the actual build policy and never relabel historical 90-second evidence", () => {
  const policy = deadlinePolicy(90_000);
  expect(validateDeadlines(policy)).toEqual(policy);
  const changed = { ...policy, buildTimeouts: { ...policy.buildTimeouts, next: 90_000 } };
  expect(validateDeadlines(changed)).toEqual(changed);
  expect(sameDeadlines(policy, changed)).toBe(false);
  const { buildTimeouts, ...historical } = policy;
  expect(buildTimeouts.next).toBe(600_000);
  expect(() => validateDeadlines(historical)).toThrow();
});

test("independent build overrides survive native forwarding and report creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-build-deadlines-"));
  try {
    const site = join(root, "site");
    await mkdir(site);
    const config = options(["--asset-source=unit", `--root=${site}`, "--timeout-ms=300000", "--build-timeout-ms=700000", "--install-timeout-ms=next:600000", "--mac-lane=build-deadlines", "--mac-thread=mcp:build-deadlines"]);
    const forwarded = options(nativeRunnerArgs(config, "/Users/fixture/tmp/goals"));
    expect(forwarded.buildTimeoutMs).toBe(700_000);
    const report = await initialReport(config);
    expect(report.deadlines).toEqual(campaignDeadlines(forwarded.timeoutMs, forwarded.installTimeouts, forwarded.buildTimeoutMs));
    expect(report.deadlines.overrides).toMatchObject({ timeoutMs: 300_000, buildTimeoutMs: 700_000 });
    expect(validateDeadlines(report.deadlines)).toEqual(report.deadlines);
    await writeFile(join(root, "TABLE.json"), JSON.stringify({ ...report, source: { ...report.source, dirty: false } }));
    const sourceFile = join(root, "source.json");
    await writeFile(sourceFile, JSON.stringify({ ...report.source, dirty: false }));
    await expect(initialReport({ ...config, output: root, resume: true, sourceFile, buildTimeoutMs: 500_000 })).rejects.toThrow("same effective deadline policy");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["", "true", "99", "900001", "1.5", "NaN", "Infinity", "next:600000"])("rejects invalid build override %j at the CLI boundary", value => {
  expect(() => options(["--asset-source=unit", `--build-timeout-ms=${value}`])).toThrow("build-timeout-ms");
});
test("rejects repeated build overrides", () => {
  expect(() => options(["--asset-source=unit", "--build-timeout-ms=600000", "--build-timeout-ms=500000"])).toThrow("repeated");
});

test.each([undefined, {}, { next: 600_000 }, { ...deadlinePolicy().buildTimeouts, next: 0 }, { ...deadlinePolicy().buildTimeouts, unknown: 600_000 }])("rejects malformed recorded build maps %j", buildTimeouts => {
  expect(() => validateDeadlines({ ...deadlinePolicy(), buildTimeouts })).toThrow();
});

import { execute } from "./execute";
import { withPlayground } from "./test-fixture";

async function buildExecution(buildTimeoutMs?: number, stallPreview = false) {
  const framework = frameworks.find(item => item.id === "next");
  if (!framework) throw new Error("Missing Next fixture");
  return withPlayground(framework, 0, transport => {
    if (stallPreview) transport.openPreview = () => new Promise(() => {});
    return execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "browser" }, url: "http://fixture/?engine=browser", timeoutMs: 100, buildTimeoutMs,
      async createTransport() { return transport; }, async saveLog() {},
    });
  }, 150);
}

test("build polling and its outer deadline use the build limit, while other phases do not", async () => {
  expect(await buildExecution()).toMatchObject({ status: "fail", phase: "build" });
  const result = await buildExecution(500);
  expect(result.status).toBe("pass");
  for (const phase of result.attempts[0]?.phases ?? []) expect(phase.timeoutMs).toBe(phase.phase === "build" ? 500 : phase.phase === "cleanup" ? 20_000 : 100);
  expect(await buildExecution(500, true)).toMatchObject({ status: "fail", phase: "render" });
});
