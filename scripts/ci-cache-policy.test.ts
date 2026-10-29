import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workflow = record(Bun.YAML.parse(source));
const steps = Object.values(record(workflow.jobs)).flatMap(job => {
  const value = record(job).steps;
  if (!Array.isArray(value)) return [];
  return value.map(record);
});

function cacheKey(step: Record<string, unknown>): string {
  const key = record(step.with).key;
  if (typeof key !== "string") throw new Error("Missing cache key");
  const id = /^\$\{\{ steps\.([\w-]+)\.outputs\.cache-primary-key \}\}$/.exec(key)?.[1];
  if (!id) return key;
  const restore = steps.find(candidate => candidate.id === id);
  if (!restore) throw new Error(`Missing cache restore ${id}`);
  return cacheKey(restore);
}

const caches = steps.filter(step => typeof step.uses === "string" && step.uses.startsWith("actions/cache"));
const heavy = caches.filter(step => /^(?:native-|jsc-(?:prebuild|cargo)-|bash-web-shell-)/.test(cacheKey(step)));
const saves = heavy.filter(step => step.uses === "actions/cache/save@v4");
const healthy: Record<string, string> = {
  "github.event_name": "push", "github.ref": "refs/heads/main",
  "needs.quality.outputs.jsc": "true",
  "steps.sources-cache.outputs.cache-hit": "false", "steps.shell-cache.outputs.cache-hit": "false",
  "steps.jsc-prebuild-cache.outputs.cache-hit": "false", "steps.jsc-cargo-cache.outputs.cache-hit": "false",
  "steps.jsc-cargo-cache.outputs.cache-matched-key": "",
  "steps.native-cargo-cache.outputs.cache-hit": "false", "steps.native-cargo-cache.outputs.cache-matched-key": "",
  "steps.native-cache.outputs.cache-hit": "false",
  "steps.native-producers.outputs.native-ready": "true", "steps.jsc-producer.outputs.jsc-ready": "true",
};

function allows(step: Record<string, unknown>, values: Record<string, string>, cancelled = false): boolean {
  if (typeof step.if !== "string") throw new Error("Heavy cache save requires a condition");
  const expression = step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "").replace(/cancelled\(\)/g, String(cancelled))
    .replace(/(?:github|steps|needs)\.[\w.-]+/g, name => {
      if (!(name in values)) throw new Error(`Missing condition input ${name}`);
      return JSON.stringify(values[name]);
    });
  const evaluate = new Function(`return (${expression})`);
  const result: unknown = Reflect.apply(evaluate, undefined, []);
  if (typeof result !== "boolean") throw new Error("Cache condition did not produce a boolean");
  return !cancelled && result;
}

test("all heavy cache actions explicitly separate restoring from saving", () => {
  expect(heavy.length).toBeGreaterThan(8);
  for (const step of heavy) {
    if (typeof step.uses !== "string") throw new Error("Missing cache action");
    expect(["actions/cache/restore@v4", "actions/cache/save@v4"]).toContain(step.uses);
  }
  expect(saves).toHaveLength(6);
});

test.each(saves)("$name reserves heavy writes for main pushes", step => {
  expect(allows(step, healthy)).toBe(true);
  expect(allows(step, { ...healthy, "github.event_name": "pull_request", "github.ref": "refs/pull/363/merge" })).toBe(false);
  expect(allows(step, { ...healthy, "github.ref": "refs/heads/feature" })).toBe(false);
  expect(allows(step, healthy, true)).toBe(false);
  const exact = Object.fromEntries(Object.entries(healthy).map(([key, value]) => [key, key.endsWith("cache-hit") ? "true" : value]));
  expect(allows(step, exact)).toBe(false);
  expect(allows(step, { ...healthy, "github.event_name": "pull_request", "steps.native-cargo-cache.outputs.cache-matched-key": "main-prefix", "steps.jsc-cargo-cache.outputs.cache-matched-key": "main-prefix" })).toBe(false);
});

test("PRs retain all heavy restore paths and native/JSC checks remain blocking", () => {
  for (const step of heavy.filter(step => step.uses === "actions/cache/restore@v4")) {
    expect(String(step.if ?? "")).not.toContain("github.event_name");
    expect(String(step.if ?? "")).not.toContain("github.ref");
  }
  expect(source).toContain("if: needs.quality.outputs.rust == 'true'");
  expect(source).toContain("name: Blocking native quality checks");
  expect(source).toContain("name: Blocking native fixture checks");
  expect(source).toContain("name: Blocking JSC embedding and allocation checks\n        if: needs.quality.outputs.jsc == 'true'");
  expect(source).not.toContain("continue-on-error:");
});
