import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ciExpression } from "./fixtures/ci-expressions";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected action object");
  return Object.fromEntries(Object.entries(value));
}

const directory = resolve(import.meta.dir, "../.github");
const read = (file: string) => record(Bun.YAML.parse(readFileSync(resolve(directory, file), "utf8")));
const restoring = read("actions/restore-ci-cache/action.yml");
const saving = read("actions/save-ci-cache/action.yml");

function steps(action: Record<string, unknown>): Record<string, unknown>[] {
  const value = record(action.runs).steps;
  if (!Array.isArray(value)) throw new Error("Expected composite steps");
  return value.map(record);
}

function admitted(step: Record<string, unknown>, runner: string, event: string, ref: string): boolean {
  if (typeof step.if !== "string") throw new Error("Cache backend must have an explicit condition");
  const result = ciExpression(step.if, { "runner.environment": runner, "github.event_name": event, "github.ref": ref });
  if (typeof result !== "boolean") throw new Error("Expected cache condition boolean");
  return result;
}

test("restore selects exactly one backend and saves remain main-only on either runner", () => {
  for (const runner of ["github-hosted", "self-hosted"]) {
    for (const event of ["pull_request", "push", "workflow_dispatch", "pull_request_target"]) {
      const restored = steps(restoring).filter(step => admitted(step, runner, event, "refs/heads/main"));
      expect(restored).toHaveLength(1);
      expect(restored[0]?.uses).toBe(runner === "github-hosted" ? "actions/cache/restore@v4" : undefined);
      const saved = steps(saving).filter(step => admitted(step, runner, event, "refs/heads/main"));
      expect(saved).toHaveLength(event === "push" ? 1 : 0);
      expect(steps(saving).filter(step => admitted(step, runner, event, "refs/heads/feature"))).toHaveLength(0);
    }
  }
});

test("local snapshots use the persistent cache root and preserve every caller path and effective key", () => {
  const localRestore = steps(restoring).find(step => step.id === "local");
  const localSave = steps(saving).find(step => typeof step.run === "string");
  expect(localRestore?.run).toBe('node "$GITHUB_WORKSPACE/scripts/ci-runner/cache.ts" restore');
  expect(localSave?.run).toBe('node "$GITHUB_WORKSPACE/scripts/ci-runner/cache.ts" save');
  expect(localRestore?.["working-directory"]).toBe("${{ github.workspace }}");
  expect(localSave?.["working-directory"]).toBe("${{ github.workspace }}");
  expect(localRestore?.env).toEqual({ BUN_WASM_PC_CACHE_ROOT: "/work/ci-runner/bun-wasm/cache", CACHE_PATHS: "${{ inputs.path }}", CACHE_KEY: "${{ inputs.key }}", CACHE_RESTORE_KEYS: "${{ inputs.restore-keys }}" });
  expect(localSave?.env).toEqual({ BUN_WASM_PC_CACHE_ROOT: "/work/ci-runner/bun-wasm/cache", CACHE_PATHS: "${{ inputs.path }}", CACHE_KEY: "${{ inputs.key }}" });
  expect(record(record(restoring.outputs)["cache-primary-key"]).value).toBe("${{ inputs.key }}");
  expect(record(record(restoring.outputs)["cache-hit"]).value).toBe("${{ steps.local.outputs.cache-hit || steps.hosted.outputs.cache-hit }}");
  expect(record(record(restoring.outputs)["cache-matched-key"]).value).toBe("${{ steps.local.outputs.cache-matched-key || steps.hosted.outputs.cache-matched-key }}");
  for (const action of [restoring, saving]) {
    const hosted = steps(action).find(step => typeof step.uses === "string");
    expect(record(hosted?.with).path).toBe("${{ inputs.path }}");
    expect(record(hosted?.with).key).toBe("${{ inputs.key }}");
    expect(JSON.stringify(action)).not.toMatch(/continue-on-error|CARGO_TARGET_DIR=|touch |stamp/);
  }
});

test("every workflow and composite cache uses the policy wrappers with no direct backend bypass", () => {
  const files = Array.from(new Bun.Glob("**/*.yml").scanSync({ cwd: directory })).sort();
  let callers = 0;
  for (const file of files) {
    if (/actions\/(?:restore|save)-ci-cache\//.test(file)) continue;
    const source = readFileSync(resolve(directory, file), "utf8");
    expect(source, file).not.toMatch(/uses: actions\/cache(?:\/|@)/);
    callers += Array.from(source.matchAll(/uses: \.\/\.github\/actions\/(?:restore|save)-ci-cache/g)).length;
  }
  expect(callers).toBeGreaterThan(80);
});

test("compiler cache rotations reach GitHub only on hosted runners after the original successful publish gates", () => {
  const action = read("actions/save-rust-build-cache/action.yml");
  const prune = steps(action).find(step => String(step.run).includes('ci-sccache-cache.ts" prune'));
  if (typeof prune?.if !== "string") throw new Error("Missing compiler snapshot retention guard");
  const condition = prune.if.replaceAll("steps.budget.outputs.changed", "'true'").replaceAll("steps.budget.outputs.fits", "'true'").replaceAll("steps.publish.outcome", "'success'");
  expect(admitted({ if: condition }, "github-hosted", "push", "refs/heads/main")).toBe(true);
  expect(admitted({ if: condition }, "self-hosted", "push", "refs/heads/main")).toBe(false);
});
