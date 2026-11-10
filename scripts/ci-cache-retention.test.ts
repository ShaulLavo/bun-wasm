import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const caches = groups.flatMap(group => group.steps.filter(step => /^actions\/cache(?:\/|@)/.test(String(step.uses))).map(step => ({ ...group, step })));
const writers = caches.filter(({ step }) => step.uses !== "actions/cache/restore@v4");

function allows(step: Record<string, unknown>, event: string, ref: string, hit = "false", changed = "true"): boolean {
  const values: Record<string, string> = { "github.event_name": event, "github.ref": ref };
  const expression = String(step.if ?? "true").replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/success\(\)/g, "true").replace(/cancelled\(\)/g, "false")
    .replace(/(?:github|steps|needs)\.[\w.-]+/g, name => {
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
  for (const file of ["actions/rust-build-cache/action.yml", "actions/browser-deps/action.yml", "actions/save-release-downloads/action.yml"]) {
    expect(files).toContain(file);
  }
  expect(writers.length).toBeGreaterThan(20);
});

test.each(writers)("$file $job $step.name $step.id saves only reusable main caches", ({ step }) => {
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

test("Rust object seeds do not create a new archive for every main commit", () => {
  const group = groups.find(group => group.file === "actions/rust-build-cache/action.yml");
  const restore = group?.steps.find(step => step.id === "objects");
  expect(restore?.uses).toBe("actions/cache/restore@v4");
  const config = record(restore?.with);
  expect(config.path).toBe("${{ runner.temp }}/sccache");
  expect(config.key).toBe("rust-objects-v2-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-${{ hashFiles('**/Cargo.lock', 'rust-toolchain.toml') }}");
  expect(String(config["restore-keys"])).toContain("rust-objects-v1-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-${{ hashFiles('**/Cargo.lock', 'rust-toolchain.toml') }}-");
  expect(String(config["restore-keys"])).toContain("rust-objects-v1-${{ runner.os }}-${{ runner.arch }}-${{ github.job }}-");
  expect(group?.steps.some(step => String(step.run).includes('echo "SCCACHE_CACHE_SIZE=512M" >> "$GITHUB_ENV"'))).toBe(true);
  for (const job of ["native-quality", "rust", "shared-sysroot"]) {
    const jobSteps = groups.find(group => group.job === job)?.steps ?? [];
    const setup = jobSteps.findIndex(step => step.uses === "./.github/actions/rust-build-cache");
    expect(jobSteps[setup]?.id).toBe("rust-objects");
    const save = jobSteps.findIndex(step => record(step.with ?? {}).key === "${{ steps.rust-objects.outputs.cache-primary-key }}");
    expect(save).toBeGreaterThan(setup);
    expect(jobSteps[save]?.uses).toBe("actions/cache/save@v4");
  }
});

test("release download saves still require a changed inventory", () => {
  const group = groups.find(group => group.file === "actions/save-release-downloads/action.yml");
  const save = group?.steps.find(step => step.uses === "actions/cache/save@v4");
  if (!save) throw new Error("Missing release download save");
  expect(allows(save, "push", "refs/heads/main", "false", "false")).toBe(false);
});
