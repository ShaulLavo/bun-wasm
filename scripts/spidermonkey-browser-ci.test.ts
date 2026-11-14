import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendCustomSection, programProfile, type PairedEngine } from "../src/engine-kind";
import { quickjsPair, sharedQuickjsPair } from "../tests/package/quickjs-plan-fixture";
import { needsRust, needsSharedNative } from "./ci-changes";
import { selectChecks } from "./test-checks";

const root = resolve(import.meta.dir, "..");
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const wrapper = join(root, "scripts/shared-wasm-memory-browser.test.ts");

function browserStep(): string {
  const step = workflow.split("      - name: Consume the shared SpiderMonkey Browser feature checks\n")[1]?.split("\n      - ")[0];
  assert(step, "missing blocking SpiderMonkey Browser consumer");
  return step;
}

test("the selected native producer feeds the discovered Browser group consumer once", () => {
  const step = browserStep();
  expect(step).toContain("if: needs.selection.outputs.shared-native == 'true'");
  expect(step).toContain('BUN_WASM_PROFILE_PROGRAM="$CARGO_TARGET_DIR/shared-native/program-spidermonkey/bun.wasm"');
  expect(step).toContain("bun scripts/run-with-timeout.mts 420 bun scripts/test-checks.ts browser-guest --profile shared-group");
  expect(step).not.toMatch(/continue-on-error|build-native|build-bun|build-engine|native --profile|BUN_WASM_SPIDERMONKEY_TIER/);
  expect(workflow.match(/name: Consume the shared SpiderMonkey Browser feature checks/g)).toHaveLength(1);
  expect(workflow.indexOf("name: Produce the shared JSC profile once")).toBeLessThan(workflow.indexOf("name: Consume the shared Browser feature checks"));
  expect(workflow.indexOf("name: Produce the shared SpiderMonkey profile once")).toBeLessThan(workflow.indexOf("name: Consume the shared JSC feature checks"));
  expect(selectChecks("browser-guest", undefined, "shared-group")).toContain("scripts/shared-wasm-memory-browser.test.ts");
  expect(selectChecks("browser-guest")).not.toContain("scripts/shared-wasm-memory-browser.test.ts");
  expect(selectChecks("quality")).toContain("scripts/spidermonkey-browser-ci.test.ts");
});

test.each([
  "scripts/spidermonkey-browser-ci.test.ts", "checks/quality-spidermonkey-browser-ci.json",
  "scripts/spidermonkey-browser-stack.test.ts", "checks/quality-spidermonkey-browser-stack.json",
  "web/tests/shared-wasm-agent/spidermonkey-stack-proof.ts",
  "scripts/shared-wasm-memory-browser.test.ts", "checks/browser-guest-shared-wasm-memory.json",
])("Browser qualification input %s selects its producer and launcher", path => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});

// Record only subprocess scheduling. Synthetic metadata never counts as an engine qualification.
function recordedRuns(kind: PairedEngine, failTier?: string) {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sm-browser-ci-"));
  try {
    const program = join(scratch, "bun.wasm"), record = join(scratch, "calls.jsonl");
    writeFileSync(program, appendCustomSection(quickjsPair(kind).core, "dylink.0", new Uint8Array()));
    writeFileSync(join(scratch, programProfile(kind).side), sharedQuickjsPair().side);
    const preload = join(scratch, "recorder.ts");
    writeFileSync(preload, `import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
mock.module("node:child_process", () => ({ execFileSync(executable, args, options) {
  const tier = options.env.BUN_WASM_SPIDERMONKEY_TIER;
  appendFileSync(process.env.RECORD, JSON.stringify({ executable, args, cwd: options.cwd, program: options.env.BUN_WASM_PROFILE_PROGRAM, tier, trace: options.env.BUN_WASM_SPIDERMONKEY_TRACE }) + "\\n");
  if (tier === process.env.FAIL_TIER) throw new Error("recorded tier failure");
} }));
`);
    const env: NodeJS.ProcessEnv = { ...process.env, BUN_WASM_PROFILE_PROGRAM: program, RECORD: record, FAIL_TIER: failTier, BUN_WASM_SPIDERMONKEY_TIER: "pbl" };
    for (const key of ["SHARED_WASM_CONTROL", "SHARED_WASM_ENTRY", "SHARED_WASM_OXC_TREE"]) delete env[key];
    const result = spawnSync(process.execPath, ["test", "--preload", preload, wrapper], { cwd: root, env, encoding: "utf8" });
    const calls: { executable: string; args: string[]; cwd: string; program: string; tier: string; trace?: string }[] = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
    return { status: result.status, output: result.stdout + result.stderr, calls, program };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("the real wrapper schedules both SpiderMonkey tiers with the same selected group and Browser driver", () => {
  const result = recordedRuns("spidermonkey");
  expect(result.status, result.output).toBe(0);
  expect(result.calls).toEqual(["interp", "pbl"].map(tier => ({
    executable: process.execPath, args: ["tests/shared-wasm-memory-browser.ts", "chromium"],
    cwd: join(root, "web"), program: result.program, tier, trace: "1",
  })));
  expect(readFileSync(wrapper, "utf8")).toContain("}, 330_000)");
});

test.each(["interp", "pbl"])("a failed %s Browser tier fails qualification", tier => {
  const result = recordedRuns("spidermonkey", tier);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("recorded tier failure");
});

test.each(["quickjs", "jsc"] satisfies PairedEngine[])("%s retains one Browser run", kind => {
  const result = recordedRuns(kind);
  expect(result.status, result.output).toBe(0);
  expect(result.calls).toHaveLength(1);
});
