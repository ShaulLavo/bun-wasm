import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function minimalMapHost(bin: string): string {
  mkdirSync(bin);
  for (const command of ["bash", "dirname", "grep"]) {
    const executable = Bun.which(command);
    assert(executable);
    symlinkSync(realpathSync(executable), join(bin, command));
  }
  return join(bin, "bash");
}

test("real member map checks work without ripgrep and reject either missing libc member", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-shared-map-"));
  try {
    const bin = join(scratch, "bin"), bash = minimalMapHost(bin);
    const env = { ...process.env, PATH: bin };
    expect(spawnSync(bash, ["-c", "command -v rg"], { env }).status).toBe(1);
    const original = readFileSync(new URL("./fixtures/shared-sysroot-member.map", import.meta.url), "utf8");
    const script = new URL("./test-shared-sysroot.sh", import.meta.url).pathname;
    const cases = [
      { name: "real", map: original, status: 0 },
      { name: "missing-allocator", map: original.split("\n").filter(line => !line.includes("libc.a(dlmalloc.c.obj)")).join("\n"), status: 1 },
      { name: "missing-sbrk", map: original.split("\n").filter(line => !line.includes("libc.a(sbrk.c.obj)")).join("\n"), status: 1 },
    ];
    for (const item of cases) {
      const map = join(scratch, `${item.name}.map`);
      writeFileSync(map, item.map);
      const result = spawnSync(bash, [script, "--check-map", map], { env, encoding: "utf8", timeout: 3000 });
      expect(result.status, item.name).toBe(item.status);
      expect(result.stderr, item.name).toBe("");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

type SharedSaveContext = { event: string; ref: string; hit: string; success: boolean; cancelled: boolean };

function sharedCacheSaves(): { name: string; condition: string }[] {
  const job: unknown = Bun.YAML.parse(shared);
  assert(job && typeof job === "object" && "steps" in job && Array.isArray(job.steps));
  return job.steps.flatMap((step: unknown) => {
    assert(step && typeof step === "object");
    if (!("uses" in step) || step.uses !== "actions/cache/save@v4") return [];
    assert("name" in step && typeof step.name === "string" && "if" in step && typeof step.if === "string");
    return [{ name: step.name, condition: step.if }];
  });
}

function sharedSaveAllowed(condition: string, state: SharedSaveContext): boolean {
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/success\(\)/g, String(state.success))
    .replace(/cancelled\(\)/g, String(state.cancelled))
    .replace(/github\.event_name/g, JSON.stringify(state.event))
    .replace(/github\.ref/g, JSON.stringify(state.ref))
    .replace(/steps\.[\w-]+\.outputs\.cache-hit/g, JSON.stringify(state.hit));
  const result: unknown = new Function(`return (${expression})`)();
  assert(typeof result === "boolean");
  return result;
}

test("all four shared saves require a successful uncancelled main push and an actual miss", () => {
  const saves = sharedCacheSaves();
  expect(saves.map(step => step.name)).toEqual([
    "Save completed shared-sdk setup",
    "Save completed shared-wasm-tools setup",
    "Save completed shared-wasmtime setup",
    "Save shared profile cache",
  ]);
  const main = { event: "push", ref: "refs/heads/main", hit: "false", success: true, cancelled: false };
  const cases = [
    { name: "cold main", state: main, allowed: true },
    { name: "main prefix or empty miss", state: { ...main, hit: "" }, allowed: true },
    { name: "exact main hit", state: { ...main, hit: "true" }, allowed: false },
    { name: "cold PR", state: { ...main, event: "pull_request", ref: "refs/pull/356/merge" }, allowed: false },
    { name: "PR prefix miss", state: { ...main, event: "pull_request", ref: "refs/pull/356/merge", hit: "" }, allowed: false },
    { name: "feature push", state: { ...main, ref: "refs/heads/feature" }, allowed: false },
    { name: "cancelled", state: { ...main, cancelled: true }, allowed: false },
    { name: "failed setup", state: { ...main, success: false }, allowed: false },
  ];
  for (const save of saves) {
    for (const item of cases) {
      expect(sharedSaveAllowed(save.condition, item.state), `${save.name}: ${item.name}`).toBe(item.allowed);
    }
  }
});
