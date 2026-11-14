import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { captureObjects } from "./ci-sccache-cache";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected YAML object");
  return Object.fromEntries(Object.entries(value));
}

function steps(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected YAML steps");
  return value.map(record);
}

const github = resolve(import.meta.dir, "../.github");
const files = Array.from(new Bun.Glob("**/*").scanSync({ cwd: github })).filter(file => /^(?:workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/.test(file)).sort();
const groups = files.flatMap(file => {
  const document = record(Bun.YAML.parse(readFileSync(resolve(github, file), "utf8")));
  if (document.runs) return [{ file, job: "composite", steps: steps(record(document.runs).steps) }];
  return Object.entries(record(document.jobs)).map(([job, value]) => ({ file, job, steps: steps(record(value).steps) }));
});
const caches = groups.flatMap(group => group.steps.filter(step => /^actions\/cache(?:\/|@)/.test(String(step.uses))).map(step => ({ ...group, step, label: String(step.name ?? step.id ?? step.uses) })));
const writers = caches.filter(({ step }) => step.uses !== "actions/cache/restore@v4");

function allows(step: Record<string, unknown>, event: string, ref: string, hit = "false", changed = "true"): boolean {
  const values: Record<string, string> = { "github.event_name": event, "github.ref": ref, "inputs.cache-hit": hit, "inputs.sysroot": "build", "steps.budget.outputs.fits": "true", "steps.publish.outcome": "success" };
  const expression = String(step.if ?? "true").replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/success\(\)/g, "true").replace(/cancelled\(\)/g, "false")
    .replace(/(?:github|steps|needs|inputs)\.[\w.-]+/g, name => {
      if (name in values) return JSON.stringify(values[name]);
      if (name.endsWith(".cache-hit")) return JSON.stringify(hit);
      if (name.endsWith(".cache-matched-key")) return JSON.stringify("");
      if (name.endsWith(".changed")) return JSON.stringify(changed);
      if (name.endsWith(".tls-sha256")) return JSON.stringify("a".repeat(64));
      if (name.startsWith("needs.quality.outputs.") || name.endsWith("-ready")) return JSON.stringify("true");
      throw new Error(`Missing condition input ${name}`);
    });
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw new Error("Cache condition must return a boolean");
  return result;
}

test("cache audit includes every local workflow and composite writer", () => {
  expect(files).toContain("workflows/ci.yml");
  for (const file of ["actions/rust-build-cache/action.yml", "actions/browser-deps/action.yml", "actions/save-release-downloads/action.yml", "actions/save-rust-build-cache/action.yml"]) {
    expect(files).toContain(file);
  }
  expect(writers.length).toBeGreaterThan(20);
});

test.each(writers)("$file $job $label saves only reusable main caches", ({ step }) => {
  expect(step.uses).toBe("actions/cache/save@v4");
  expect(allows(step, "push", "refs/heads/main")).toBe(true);
  expect(allows(step, "pull_request", "refs/pull/598/merge")).toBe(false);
  expect(allows(step, "pull_request_target", "refs/heads/main")).toBe(false);
  expect(allows(step, "push", "refs/heads/feature")).toBe(false);
  expect(allows(step, "workflow_dispatch", "refs/heads/main")).toBe(false);
  if (String(step.if).includes("cache-hit")) expect(allows(step, "push", "refs/heads/main", "true")).toBe(false);
});

test("PRs can still restore all shared caches, including compiler objects and tools", () => {
  for (const { step } of caches.filter(({ step }) => step.uses === "actions/cache/restore@v4")) {
    expect(String(step.if ?? "")).not.toContain("github.event_name");
    expect(String(step.if ?? "")).not.toContain("github.ref");
  }
  for (const job of ["native-quality", "rust"]) {
    const group = groups.find(group => group.job === job);
    const restore = group?.steps.find(step => step.uses === "./.github/actions/rust-build-cache");
    expect(restore).toBeDefined();
    expect(restore).not.toHaveProperty("if");
    expect(group?.steps.find(step => step.id === "wasm-tools-cache")?.uses).toBe("actions/cache/restore@v4");
  }
});

test("Rust objects restore compatible generations and save only changed inventories", () => {
  const group = groups.find(group => group.file === "actions/rust-build-cache/action.yml");
  const restore = group?.steps.find(step => step.id === "objects");
  expect(restore?.uses).toBe("actions/cache/restore@v4");
  const config = record(restore?.with);
  expect(config.path).toBe("${{ runner.temp }}/sccache");
  const action = record(Bun.YAML.parse(readFileSync(resolve(github, "actions/rust-build-cache/action.yml"), "utf8")));
  expect(record(record(action.outputs)["cache-primary-key"]).value).toBe("${{ steps.object-key.outputs.key }}");
  expect(record(action.outputs)).not.toHaveProperty("cache-hit");
  expect(config.key).toBe("${{ steps.object-key.outputs.key }}-restore");
  expect(String(config["restore-keys"])).toContain("${{ steps.object-key.outputs.key }}-");
  expect(String(config["restore-keys"])).toContain("rust-objects-v3-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-");
  expect(String(config["restore-keys"])).toContain("rust-objects-v2-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-");
  const key = group?.steps.find(step => step.id === "object-key");
  expect(String(key?.run)).toContain("rust-objects-v3-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-${{ hashFiles('**/Cargo.lock', 'rust-toolchain.toml') }}");
  expect(group?.steps.findIndex(step => String(step.run).includes("ci-sccache-cache.ts\" capture"))).toBeGreaterThan(group?.steps.findIndex(step => step.id === "objects") ?? -1);
  expect(group?.steps.some(step => String(step.run).includes('echo "SCCACHE_CACHE_SIZE=512M" >> "$GITHUB_ENV"'))).toBe(true);
  for (const job of ["native-quality", "rust", "shared-sysroot"]) {
    const jobSteps = groups.find(group => group.job === job)?.steps ?? [];
    const setup = jobSteps.findIndex(step => step.uses === "./.github/actions/rust-build-cache");
    expect(jobSteps[setup]?.id).toBe("rust-objects");
    const save = jobSteps.findIndex(step => step.uses === "./.github/actions/save-rust-build-cache");
    expect(save).toBeGreaterThan(setup);
    expect(record(jobSteps[save]?.with)).toEqual({
      key: "${{ steps.rust-objects.outputs.cache-primary-key }}",
    });
  }
});

test("release download saves still require a changed inventory", () => {
  const group = groups.find(group => group.file === "actions/save-release-downloads/action.yml");
  const saves = group?.steps.filter(step => step.uses === "actions/cache/save@v4") ?? [];
  expect(saves).toHaveLength(2);
  for (const save of saves) expect(allows(save, "push", "refs/heads/main", "false", "false")).toBe(false);
});

test("compiler-object rotation is main-only and waits for a successful changed snapshot", () => {
  const group = groups.find(group => group.file === "actions/save-rust-build-cache/action.yml");
  const cleanup = group?.steps.find(step => String(step.run).includes("ci-sccache-cache.ts\" prune"));
  if (!cleanup) throw new Error("Missing bounded compiler-object rotation");
  expect(String(cleanup.if)).toContain("steps.publish.outcome == 'success'");
  expect(String(cleanup.if)).toContain("steps.budget.outputs.changed == 'true'");
  expect(String(cleanup.if)).toContain("steps.budget.outputs.fits == 'true'");
  expect(allows(cleanup, "push", "refs/heads/main")).toBe(true);
  expect(allows(cleanup, "pull_request", "refs/pull/1/merge")).toBe(false);
  expect(allows(cleanup, "workflow_dispatch", "refs/heads/main")).toBe(false);
  expect(allows(cleanup, "push", "refs/heads/main", "true", "false")).toBe(false);
  expect(allows({ ...cleanup, if: String(cleanup.if).replaceAll("steps.publish.outcome", "'failure'") }, "push", "refs/heads/main")).toBe(false);
  const jobs = record(record(Bun.YAML.parse(readFileSync(resolve(github, "workflows/ci.yml"), "utf8"))).jobs);
  const writers = Object.entries(jobs).filter(([, value]) => record(record(value).permissions ?? {}).actions === "write");
  expect(writers.map(([id]) => id).sort()).toEqual(["native-quality", "rust", "shared-sysroot"]);
  for (const [, job] of writers) expect(record(record(job).permissions).contents).toBe("read");
});

test("Rust snapshot plans reject oversized learned objects and suppress unchanged archives", async () => {
  const group = groups.find(group => group.file === "actions/save-rust-build-cache/action.yml");
  const budget = group?.steps.find(step => step.id === "budget");
  const save = group?.steps.find(step => step.uses === "actions/cache/save@v4");
  const command = budget?.run;
  if (typeof command !== "string" || !save) throw new Error("Missing Rust seed size gate");
  expect(String(save.if)).toContain("steps.budget.outputs.fits == 'true'");
  expect(String(save.if)).toContain("steps.budget.outputs.changed == 'true'");
  expect(String(save.if)).not.toContain("cache-hit");
  expect(record(save.with).key).toBe("${{ inputs.key }}-${{ steps.budget.outputs.fingerprint }}-${{ github.run_id }}-${{ github.run_attempt }}");
  expect(allows(save, "push", "refs/heads/main", "true")).toBe(true);
  expect(allows(save, "push", "refs/heads/main", "false", "false")).toBe(false);
  expect(allows({ ...save, if: String(save.if).replaceAll("steps.budget.outputs.fits", "''") }, "push", "refs/heads/main")).toBe(false);
  const root = mkdtempSync(resolve(tmpdir(), "bun-wasm-cache-retention-"));
  const cache = resolve(root, "cache");
  const output = resolve(root, "output");
  const snapshot = resolve(root, "initial.json");
  const invoke = () => spawnSync("bash", ["-euo", "pipefail", "-c", command], {
    encoding: "utf8", env: { ...process.env, CACHE_PATH: cache, SNAPSHOT_PATH: snapshot, GITHUB_OUTPUT: output, GITHUB_WORKSPACE: resolve(github, "..") },
  });
  try {
    await captureObjects(cache, snapshot);
    writeFileSync(output, "");
    expect(invoke().status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("changed=false\n");
    writeFileSync(output, "");
    mkdirSync(resolve(cache, "a/a"), { recursive: true });
    const object = resolve(cache, "a/a", "a".repeat(64));
    writeFileSync(object, "compiler object");
    expect(invoke().status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("changed=true\nfits=true\n");
    await captureObjects(cache, snapshot);
    writeFileSync(output, "");
    expect(invoke().status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("changed=false\n");
    truncateSync(object, 603979777);
    writeFileSync(output, "");
    const oversized = invoke();
    expect(oversized.status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("changed=true\nfits=false\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
