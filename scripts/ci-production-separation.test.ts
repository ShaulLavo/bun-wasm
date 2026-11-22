import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCiSuccess } from "./ci-result";
import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = object(Bun.YAML.parse(read(".github/workflows/ci.yml")));
const jobs = object(workflow.jobs);
const expanded = object(object(Bun.YAML.parse(expandedCiWorkflow())).jobs);
const job = (id: string, expand = false) => object((expand ? expanded : jobs)[id]);

function steps(value: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(value.steps)) throw new Error("Missing steps");
  return value.steps.map(object);
}

function action(name: string) {
  return object(object(Bun.YAML.parse(read(`.github/actions/${name}/action.yml`))).runs);
}

function named(entries: Record<string, unknown>[], name: string) {
  const step = entries.find(step => step.name === name);
  if (!step) throw new Error(`Missing ${name}`);
  return step;
}

type Need = { result: string; outputs?: Record<string, string> };
type Needs = Record<string, Need>;

function admitted(id: string, needs: Needs, event = "pull_request", cancelled = false): boolean {
  const definition = job(id);
  if (typeof definition.if !== "string") throw new Error("Missing explicit admission");
  const expression = definition.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("always()", "true").replaceAll("cancelled()", String(cancelled))
    .replaceAll("github.event_name", JSON.stringify(event)).replaceAll("github.event.pull_request.draft", "false")
    .replace(/needs\.([\w-]+)\.(result|outputs\.([\w-]+))/g, (_match, dep: string, _field: string, key: string | undefined) =>
      JSON.stringify(key ? needs[dep]?.outputs?.[key] ?? "" : needs[dep]?.result ?? ""));
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw new Error("Admission must be boolean");
  const explicitStatus = /(?:always|success|failure|cancelled)\(\)/.test(definition.if);
  return result && (explicitStatus || (!cancelled && Object.values(needs).every(need => need.result === "success")));
}

const states = ["success", "failure", "cancelled", "skipped", ""];

function selection(rust: string, browser: string): Need {
  return { result: "success", outputs: { rust, browser_guest: browser, jsc: "false", shared: "false", "shared-native": "false" } };
}

test.each(["pull_request", "push", "workflow_dispatch"])("actual %s joins require ordinary-build and honor full vs browser-only routes", event => {
  const flags = ["true", "false", "", "yes"].flatMap(rust => ["true", "false", "", "yes"].map(browser => ({ rust, browser })));
  for (const { rust, browser } of flags) {
    const full = rust === "true" || (event !== "pull_request" && rust === "false" && browser === "true");
    const needs: Needs = { selection: selection(rust, browser), "ordinary-build": { result: "success" }, "web-browser": { result: "success" } };
    expect(admitted("ordinary-build", { selection: selection(rust, browser) }, event)).toBe(rust === "true" || browser === "true");
    expect(admitted("native-quality", { selection: selection(rust, browser) }, event)).toBe(full);
    expect(admitted("rust", { selection: selection(rust, browser), "ordinary-build": { result: "success" } }, event)).toBe(full);
    expect(admitted("rust-fixtures", { selection: selection(rust, browser), "ordinary-build": { result: "success" } }, event)).toBe(full);
    expect(admitted("browser-guest", needs, event)).toBe(browser === "true");
    expect(admitted("browser-guest", needs, event, true)).toBe(false);
  }
});

test("selected JSC Browser rows run inside ordinary-build without acquiring native quality or runtime jobs on PRs", () => {
  const sel: Need = { ...selection("false", "true"), outputs: { ...selection("false", "true").outputs, jsc: "true" } };
  expect(admitted("ordinary-build", { selection: sel })).toBe(true);
  expect(admitted("native-quality", { selection: sel })).toBe(false);
  expect(admitted("rust", { selection: sel, "ordinary-build": { result: "success" } })).toBe(false);
  expect(admitted("rust-fixtures", { selection: sel, "ordinary-build": { result: "success" } })).toBe(false);
  const valid = results(false, true);
  valid.selection = { ...valid.selection!, outputs: sel.outputs };
  expect(() => requireCiSuccess(valid)).not.toThrow();
  const producer = steps(job("ordinary-build"));
  expect(object(producer.find(step => step.uses === "./.github/actions/native-production")!.with).jsc).toBe("${{ needs.selection.outputs.jsc }}");
  const entries = steps(job("ordinary-build", true));
  for (const name of ["Start the JSC Cargo guest build", "Build the JSC Cargo guest"]) expect(named(entries, name).if).toBe("needs.selection.outputs.jsc == 'true'");
  expect(entries.indexOf(named(entries, "Build the JSC Cargo guest"))).toBeLessThan(entries.indexOf(named(entries, "Build the browser-guest site once")));
});

function results(rust: boolean, browser: boolean) {
  const fullOnly = new Set(["native-quality", "rust", "rust-fixtures"]);
  const shared = new Set(["shared-sysroot", "shared-consumers"]);
  const required = job("ci-result").needs;
  if (!Array.isArray(required) || required.some(id => typeof id !== "string")) throw new Error("Missing aggregate graph");
  return Object.fromEntries(required.map(id => {
    const enabled = fullOnly.has(id) ? rust : id === "ordinary-build" ? rust || browser : id === "browser-guest" ? browser : shared.has(id) ? false : true;
    return [id, { result: enabled ? "success" : "skipped", outputs: id === "selection" ? selection(String(rust), String(browser)).outputs : {} }];
  }));
}

test("aggregate rejects every failed, missing, cancelled or unexpected provider without fallback", () => {
  for (const [rust, browser] of [[true, true], [false, true], [false, false]] as const) {
    const valid = results(rust, browser);
    expect(() => requireCiSuccess(valid)).not.toThrow();
    for (const status of states) {
      const candidate = { ...valid, "ordinary-build": { result: status } };
      const correct = status === (rust || browser ? "success" : "skipped");
      if (correct) expect(() => requireCiSuccess(candidate)).not.toThrow();
      if (!correct) expect(() => requireCiSuccess(candidate)).toThrow();
    }
    for (const id of ["ordinary-build", "rust", "rust-fixtures", "native-quality"]) {
      const missing = { ...valid };
      delete missing[id];
      expect(() => requireCiSuccess(missing)).toThrow();
    }
  }
  for (const event of ["push", "workflow_dispatch"]) {
    const full = results(true, true);
    full.selection = { ...full.selection!, outputs: selection("false", "true").outputs };
    expect(() => requireCiSuccess(full, event)).not.toThrow();
    expect(() => requireCiSuccess(results(false, true), event)).toThrow();
  }
  expect(() => requireCiSuccess(results(true, false))).toThrow("Browser consumers");
  const missingProduction = results(false, false);
  missingProduction.selection = { ...missingProduction.selection!, outputs: { ...selection("false", "false").outputs, jsc: "true" } };
  expect(() => requireCiSuccess(missingProduction)).toThrow("JSC consumers");
  expect(() => requireCiSuccess(results(true, true), "unknown")).toThrow("Invalid CI event");
});

test("ordinary-build shares native-setup, native-seed and native-production with main-only cache writes", () => {
  const entries = steps(job("ordinary-build"));
  const setup = entries.find(step => step.uses === "./.github/actions/native-setup");
  const seed = entries.find(step => step.uses === "./.github/actions/native-seed");
  const produce = entries.find(step => step.uses === "./.github/actions/native-production");
  expect(setup).toBeDefined();
  expect(seed).toBeDefined();
  expect(produce).toBeDefined();
  expect(object(setup!.with)["node-version"]).toBe("${{ env.CI_NODE_VERSION }}");
  expect(object(setup!.with)["cache-scope"]).toBe("rust");
  const producer = read(".github/actions/native-production/action.yml");
  for (const command of ["BROWSER_CARGO_TARGET_DIR=\"$CARGO_TARGET_DIR\" JOBS=3 bash scripts/build-bun-browser.sh", "TOOLS_CARGO_TARGET_DIR=\"$CARGO_TARGET_DIR\" JOBS=4 bash scripts/build-bun-tools.sh", "CARGO_BUILD_JOBS=3 bash scripts/build.sh", "CARGO_BUILD_JOBS=3 bash scripts/build-bun-spidermonkey.sh"]) expect(producer.split(command)).toHaveLength(2);
  for (const step of steps(job("ordinary-build", true)).filter(step => step.uses === "actions/cache/save@v4")) {
    expect(step.if).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  }
  const commands = JSON.stringify(steps(job("ordinary-build", true)));
  expect(commands).toContain("bash scripts/sync-bun.sh\\nbash scripts/sync-crypto.sh");
  expect(commands.indexOf("Prepare pinned Rust standard-library dependencies")).toBeLessThan(commands.indexOf("Build the common engine core once"));
  const std = named(steps(job("ordinary-build", true)), "Prepare pinned Rust standard-library dependencies");
  expect(std.run).toContain('"$GUEST_CARGO" fetch --locked --manifest-path "$sysroot/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1');
});

test("empty seed preparation rejects an existing target, registry or git cache rather than overlaying", () => {
  const script = named(steps(action("native-seed")), "Require empty seed destinations").run;
  if (typeof script !== "string") throw new Error("Missing seed check");
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-production-seed-"));
  try {
    const env = { ...process.env, CARGO_HOME: join(root, "cargo"), CARGO_TARGET_DIR: join(root, "target") };
    expect(spawnSync("bash", ["-euc", script], { env }).status).toBe(0);
    for (const path of [env.CARGO_TARGET_DIR, join(env.CARGO_HOME, "registry"), join(env.CARGO_HOME, "git")]) {
      mkdirSync(path, { recursive: true });
      expect(spawnSync("bash", ["-euc", script], { env }).status).not.toBe(0);
      rmSync(path, { recursive: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rust object cache uses explicit scope input across callers", () => {
  const objects = read(".github/actions/rust-build-cache/action.yml");
  expect(objects).toContain("default: ${{ github.job }}");
  expect(objects.match(/rust-objects-v[23]-.+\$\{\{ inputs.scope \}\}/g)).toHaveLength(4);
  expect(objects).not.toContain("${{ github.job }}-");
  const setupSteps = steps(action("native-setup"));
  for (const uses of ["./.github/actions/rust-build-cache", "./.github/actions/release-downloads"]) {
    expect(object(setupSteps.find(step => step.uses === uses)!.with).scope).toBe("${{ inputs.cache-scope }}");
  }
});

test("composite steps use supported metadata and transfers retain their five-minute hang caps", () => {
  for (const name of ["native-setup", "native-seed", "native-production"]) {
    for (const step of steps(action(name))) requireSupportedStep(step);
  }
  for (const id of ["ordinary-build", "rust", "rust-fixtures", "browser-guest", "shared-consumers"]) {
    const transfers = steps(job(id)).filter(step => /^actions\/(?:upload|download)-artifact@/.test(String(step.uses)));
    expect(transfers.length).toBeGreaterThan(0);
    for (const step of transfers) expect(step["timeout-minutes"]).toBe(5);
  }
});

function requireSupportedStep(step: Record<string, unknown>): void {
  const allowed = new Set(["name", "id", "if", "run", "uses", "env", "with", "shell", "working-directory", "continue-on-error"]);
  expect(Object.keys(step).every(key => allowed.has(key))).toBe(true);
  if (typeof step.run === "string") {
    expect(step.shell).toBeString();
    expect(step.shell).not.toBe("");
  }
}

test("coverage outputs add only browser production and the actually selected JSC rows", () => {
  const outputs = object(job("selection").outputs);
  const values = ["true", "false"];
  for (const rust of values) for (const browser of values) checkCoverageOutputs(outputs, rust, browser);
});

function checkCoverageOutputs(outputs: Record<string, unknown>, rust: string, browser: string): void {
  for (const needed of ["true", "false"]) for (const jsc of ["true", "false"]) {
    const values: Record<string, string> = {
      "steps.changes.outputs.rust": rust, "steps.changes.outputs.browser_guest": browser,
      "steps.changes.outputs.jsc": "false", "steps.browser-guest-batches.outputs.needed": needed,
      "steps.browser-guest-batches.outputs.jsc": jsc,
    };
    expect(evaluateOutput(outputs, values, "rust")).toBe(rust);
    expect(evaluateOutput(outputs, values, "browser_guest")).toBe(browser === "true" || needed === "true");
    expect(evaluateOutput(outputs, values, "jsc")).toBe(jsc === "true");
  }
}

function evaluateOutput(outputs: Record<string, unknown>, values: Record<string, string>, key: string): unknown {
  const expression = String(outputs[key]).replace(/^\$\{\{\s*|\s*\}\}$/g, "").replace(/steps\.[\w.-]+/g, key => JSON.stringify(values[key]));
  return new Function(`return (${expression})`)();
}
