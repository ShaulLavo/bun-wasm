import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsSharedSysroot } from "./ci-changes";
import { discoverChecks } from "./test-checks";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const shared = workflow.split("\n  shared-sysroot:\n")[1]!.split("\n  web:\n")[0]!;

test("the dedicated shared profile gate is blocking and never invokes an engine build", () => {
  expect(shared).toContain("needs: quality");
  expect(shared).toContain("if: needs.quality.outputs.shared == 'true'");
  expect(shared).toContain("node-version: '26'");
  expect(shared).toContain('echo "TMPDIR=$RUNNER_TEMP" >> "$GITHUB_ENV"');
  expect(shared).toContain("bun scripts/build-wasi-sysroot.ts --shared-pic --inputs");
  expect(shared).toContain("bun scripts/build-wasi-sysroot.ts --shared-pic\n");
  expect(shared).toContain('bash scripts/test-shared-sysroot.sh "$RUNNER_TEMP/shared-sysroot-proof"');
  expect(shared).not.toMatch(/continue-on-error|cargo |build-engine|build-bun|sync-bun/);
  expect(shared).toContain("v1.262.0/wasm-tools");
  expect(shared).toContain("v49.0.3/wasmtime");
  expect(shared).toContain("key: wasi-sdk-34.0-stock-${{ runner.os }}-${{ runner.arch }}");
  expect(shared).toContain("key: wasi-shared-pic-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.shared-inputs.outputs.hash }}");
  expect(shared).toContain('path: ${{ env.BUN_WASM_SHARED_SYSROOT }}');
  expect(shared).not.toContain("bun-wasm-sysroot-patched");
});

test("default and shared input isolation has one lightweight blocking owner", () => {
  expect(discoverChecks().filter(check => check.path === "scripts/shared-sysroot-inputs.test.ts"))
    .toEqual([{ owner: "quality", path: "scripts/shared-sysroot-inputs.test.ts", localRuntime: false, batch: "default" }]);
  expect(needsSharedSysroot(["scripts/shared-sysroot-inputs.test.ts"])).toBe(true);
  expect(needsSharedSysroot(["scripts/shared-sysroot-ci.test.ts"])).toBe(true);
});

function runnerInJobEnvironment(env: unknown): boolean {
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  return Object.values(env).some(value => typeof value === "string" && /\$\{\{[^}]*\brunner\s*(?:\.|\[)/.test(value));
}

test("workflow job environments cannot reference the step-only runner context", () => {
  const parsed: unknown = Bun.YAML.parse(workflow);
  assert(parsed && typeof parsed === "object" && "jobs" in parsed);
  const jobs = parsed.jobs;
  assert(jobs && typeof jobs === "object" && !Array.isArray(jobs));
  for (const [name, job] of Object.entries(jobs)) {
    assert(job && typeof job === "object");
    expect(runnerInJobEnvironment("env" in job ? job.env : undefined), name).toBe(false);
  }
  expect(runnerInJobEnvironment({ TMPDIR: "${{ runner.temp }}" })).toBe(true);
  expect(runnerInJobEnvironment({ TMPDIR: "${{ runner['temp'] }}" })).toBe(true);
});

test("shared setup publishes the same private paths before the first cache restore", () => {
  const setup = shared.match(/      - name: Configure private shared sysroot paths\n        run: \|\n((?:          .*\n)+)/)?.[1];
  assert(setup);
  expect(shared.indexOf(setup)).toBeLessThan(shared.indexOf("uses: actions/cache/restore@v4"));
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-shared-workflow-"));
  try {
    const output = join(scratch, "github-env");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", setup], {
      env: { ...process.env, RUNNER_TEMP: scratch, GITHUB_ENV: output }, encoding: "utf8", timeout: 3000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(output, "utf8").trim().split("\n")).toEqual([
      `WASM_TOOLS=${scratch}/wasm-tools`,
      `BUN_WASM_SHARED_SYSROOT=${scratch}/bun-wasm-shared-sysroot`,
      `BUN_WASM_SYSROOT=${scratch}/bun-wasm-shared-sysroot`,
      `TMPDIR=${scratch}`,
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
