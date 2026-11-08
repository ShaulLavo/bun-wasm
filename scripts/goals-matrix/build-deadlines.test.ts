import { expect, test } from "bun:test";
import { deadlinePolicy, validateDeadlines, sameDeadlines } from "./deadlines";
import { frameworks } from "./catalog";
import { options } from "./run";

test("the measured Next build budget leaves every other framework and phase at 90 seconds", () => {
  const config = options(["--asset-source=unit"]);
  expect(config.timeoutMs).toBe(90_000);
  const policy = deadlinePolicy(90_000);
  for (const framework of frameworks) {
    expect(policy.installTimeouts[framework.id]).toBe(90_000);
    expect(policy.buildTimeouts[framework.id]).toBe(framework.id === "next" ? 110_000 : 90_000);
  }
  expect(policy.cleanupTimeoutMs).toBe(20_000);
  expect(deadlinePolicy(180_000).buildTimeouts.next).toBe(180_000);
});

test("reports require the actual build policy and never relabel historical 90-second evidence", () => {
  const policy = deadlinePolicy(90_000);
  expect(validateDeadlines(policy)).toEqual(policy);
  const changed = { ...policy, buildTimeouts: { ...policy.buildTimeouts, next: 90_000 } };
  expect(() => validateDeadlines(changed)).toThrow();
  expect(sameDeadlines(policy, changed)).toBe(false);
  const { buildTimeouts, ...historical } = policy;
  expect(buildTimeouts.next).toBe(110_000);
  expect(() => validateDeadlines(historical)).toThrow();
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
