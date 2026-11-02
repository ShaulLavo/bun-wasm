import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type StorageRecord = {
  readonly component: string;
  readonly label: string;
  readonly freeBytes: number;
  readonly retainedBytes: number;
  readonly paths: readonly { path: string; exists: boolean; diskBytes: number }[];
};

function runStorage(root: string, label: string, paths: readonly string[]): StorageRecord {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "ci-storage.ts"), label].concat(paths), {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as StorageRecord;
}

function pathRecord(record: StorageRecord, path: string) {
  const found = record.paths.find(item => item.path === path);
  expect(found).toBeDefined();
  return found!;
}

function storageFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-ci-storage-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("storage measurements report retained bytes and an absent cleanup path", () => {
  storageFixture(root => {
    const transfer = join(root, "transfer");
    const output = join(root, "output");
    writeFileSync(transfer, Buffer.alloc(4097, 7));
    writeFileSync(output, Buffer.alloc(17, 3));

    const before = runStorage(root, "before", [transfer, output]);
    expect(before.component).toBe("ci-storage");
    expect(before.label).toBe("before");
    expect(before.freeBytes).toBeGreaterThan(0);
    expect(pathRecord(before, transfer)).toMatchObject({ path: transfer, exists: true });
    expect(pathRecord(before, transfer).diskBytes).toBeGreaterThan(0);
    expect(before.retainedBytes).toBeGreaterThan(0);

    rmSync(transfer);
    const after = runStorage(root, "cleanup", [transfer, output]);
    expect(pathRecord(after, transfer)).toEqual({ path: transfer, exists: false, diskBytes: 0 });
    expect(pathRecord(after, output).exists).toBe(true);
  });
});

function workflowSteps(job: string): readonly Record<string, unknown>[] {
  const workflow = record(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
  const jobs = record(workflow.jobs);
  const steps = record(jobs[job]).steps;
  if (!Array.isArray(steps)) throw new Error(`Missing workflow steps for ${job}`);
  return steps.map(record);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

function storageCommand(step: Record<string, unknown>): string {
  return typeof step.run === "string" ? step.run : "";
}

function stepIndex(steps: readonly Record<string, unknown>[], needle: string): number {
  return steps.findIndex(step => storageCommand(step).includes(needle));
}

test("workflow records transfer cleanup after each import", () => {
  const producer = workflowSteps("jsc-prebuild");
  const native = workflowSteps("rust");
  for (const [steps, labels] of [
    [producer, ["jsc-package-before", "jsc-package-after", "jsc-package-cleanup"]],
    [native, ["jsc-import-before", "jsc-import-after-prebuild", "jsc-import-after-sysroot", "jsc-import-after-cleanup", "native-import-before", "native-import-after", "native-import-cleanup"]],
  ] as const) {
    for (const label of labels) expect(stepIndex(steps, `bun scripts/ci-storage.ts ${label}`)).toBeGreaterThanOrEqual(0);
  }
  const jscCleanup = stepIndex(native, "rm -r -- \"$manifest\" \"$RUNNER_TEMP/jsc-prebuild-transfer\"");
  expect(jscCleanup).toBeGreaterThanOrEqual(0);
  const jscCleanupScript = storageCommand(native[jscCleanup]!);
  expect(jscCleanupScript.indexOf("rm -r --")).toBeLessThan(jscCleanupScript.indexOf("jsc-import-after-cleanup"));
  const nativeCleanup = stepIndex(native, "rm -r -- \"$RUNNER_TEMP/native-quality-transfer\"");
  expect(nativeCleanup).toBeGreaterThanOrEqual(0);
  const nativeCleanupScript = storageCommand(native[nativeCleanup]!);
  expect(nativeCleanupScript.indexOf("rm -r --")).toBeLessThan(nativeCleanupScript.indexOf("native-import-cleanup"));
});

test("storage helper rejects missing label or paths", () => {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "ci-storage.ts")], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Usage: ci-storage.ts LABEL PATH...");
});
