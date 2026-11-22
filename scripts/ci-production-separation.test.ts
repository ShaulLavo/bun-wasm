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
    .replace(/needs\.([\w-]+)\.(result|outputs\.([\w-]+))/g, (_match, id: string, _field: string, key: string | undefined) =>
      JSON.stringify(key ? needs[id]?.outputs?.[key] ?? "" : needs[id]?.result ?? ""));
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw new Error("Admission must be boolean");
  const explicitStatus = /(?:always|success|failure|cancelled)\(\)/.test(definition.if);
  return result && (explicitStatus || Object.values(needs).every(need => need.result === "success"));
}

const states = ["success", "failure", "cancelled", "skipped", ""];
const producerStates = states.flatMap(rust => states.map(browser => ({ rust, browser })));

function selection(rust: string, browser: string): Need {
  return { result: "success", outputs: { rust, browser_guest: browser, jsc: "false", shared: "false", "shared-native": "false" } };
}

test.each(["pull_request", "push", "workflow_dispatch"])("actual %s joins require exactly the selected successful provider", event => {
  const flags = ["true", "false", "", "yes"].flatMap(rust => ["true", "false", "", "yes"].map(browser => ({ rust, browser })));
  for (const flagsCase of flags) checkProviders(event, flagsCase);
});

function checkProviders(event: string, flags: { rust: string; browser: string }): void {
  for (const result of producerStates) {
    const full = (flags.rust === "true" || event !== "pull_request" && flags.rust === "false" && flags.browser === "true") && flags.browser === "true" && result.rust === "success" && result.browser === "skipped";
    const alternate = event === "pull_request" && flags.rust === "false" && flags.browser === "true" && result.rust === "skipped" && result.browser === "success";
    const sourceOnly = flags.rust === "false" && flags.browser === "false" && result.rust === "skipped" && result.browser === "skipped";
    const needs: Needs = { selection: selection(flags.rust, flags.browser), rust: { result: result.rust }, "browser-production": { result: result.browser }, "ordinary-web-guests": { result: full ? "success" : "skipped" }, "process-bundles": { result: "success" }, "browser-guest": { result: sourceOnly ? "skipped" : "success" } };
    expect(admitted("browser-guest", needs, event)).toBe(full || alternate);
    expect(admitted("browser-process", needs, event)).toBe(full || alternate || sourceOnly);
    expect(admitted("browser-guest", needs, event, true)).toBe(false);
    expect(admitted("browser-process", needs, event, true)).toBe(false);
  }
}

test("actual producers are mutually exclusive and dispatch retains full production", () => {
  for (const event of ["pull_request", "push", "workflow_dispatch"]) checkProducerSelection(event);
});

test("selected JSC Browser rows use the alternate producer without acquiring native correctness", () => {
  const needs: Needs = { selection: { ...selection("false", "true"), outputs: { ...selection("false", "true").outputs, jsc: "true" } }, "jsc-prebuild": { result: "success" }, "native-quality": { result: "skipped" } };
  expect(admitted("browser-production", needs)).toBe(true);
  expect(admitted("rust", needs)).toBe(false);
  const valid = results(false, true);
  valid.selection = { ...valid.selection!, outputs: needs.selection!.outputs };
  expect(() => requireCiSuccess(valid)).not.toThrow();
  const producer = steps(job("browser-production"));
  expect(object(producer.find(step => step.uses === "./.github/actions/native-production")!.with).jsc).toBe("${{ needs.selection.outputs.jsc }}");
  const entries = steps(job("browser-production", true));
  for (const name of ["Start the JSC Cargo guest build", "Build the JSC Cargo guest"]) expect(named(entries, name).if).toBe("needs.selection.outputs.jsc == 'true'");
  expect(named(entries, "Blocking Web guest case (JSC)").if).toBe("needs.selection.outputs.jsc == 'true'");
  expect(entries.indexOf(named(entries, "Build the JSC Cargo guest"))).toBeLessThan(entries.indexOf(named(entries, "Build the browser-guest site once")));
});

test("Processes requires every selected Browser batch before real guests, while source-only checks remain unconditional", () => {
  const entries = steps(job("browser-process"));
  const guard = named(entries, "Require every selected Browser guest batch").run;
  if (typeof guard !== "string") throw new Error("Missing Browser batch guard");
  const cases = ["true", "false", "", "yes"].flatMap(selected => states.map(result => ({ selected, result })));
  for (const { selected, result } of cases) {
    const run = spawnSync("bash", ["-euc", guard], { env: { ...process.env, BROWSER_GUEST: selected, GUEST_RESULT: result } });
    expect(run.status === 0).toBe((selected === "true" && result === "success") || (selected === "false" && result === "skipped"));
  }
  for (const step of entries.filter(step => /no Rust or dist artifacts/.test(String(step.name)))) expect(step.if).toBeUndefined();
  const guestSteps = entries.filter(step => step.name === "Real Bun source cache in one Waffle browser runtime" || step.name === "Native Wasm module and shared-memory worker transfer" || (step.with && object(step.with).name === "browser-program"));
  expect(guestSteps).toHaveLength(3);
  for (const step of guestSteps) expect(step.if).toBe("needs.selection.outputs.browser_guest == 'true'");
});

function checkProducerSelection(event: string): void {
  for (const rust of ["true", "false"]) for (const browser of ["true", "false"]) {
    const needs: Needs = { selection: selection(rust, browser), "jsc-prebuild": { result: "success" }, "native-quality": { result: "success" } };
    const full = admitted("rust", needs, event);
    const alternate = admitted("browser-production", needs, event);
    expect(full && alternate).toBe(false);
    expect(alternate).toBe(event === "pull_request" && rust === "false" && browser === "true");
    if (event !== "pull_request") expect(alternate).toBe(false);
  }
}

function results(rust: boolean, browser: boolean) {
  const native = new Set(["native-quality", "rust", "ordinary-web-guests"]);
  const backing = new Set(["jsc-identity", "jsc-prebuild", "browser-guest"]);
  const shared = new Set(["shared-jsc-identity", "shared-prebuild", "shared-spidermonkey-prebuild", "shared-sysroot", "shared-consumers", "shared-proof"]);
  const required = job("ci-result").needs;
  if (!Array.isArray(required) || required.some(id => typeof id !== "string")) throw new Error("Missing aggregate graph");
  return Object.fromEntries(required.map(id => {
    const enabled = native.has(id) ? rust : backing.has(id) ? browser : shared.has(id) ? false : id === "browser-production" ? browser && !rust : true;
    return [id, { result: enabled ? "success" : "skipped", outputs: id === "selection" ? selection(String(rust), String(browser)).outputs : {} }];
  }));
}

test("aggregate rejects every failed, missing, cancelled or unexpected provider without fallback", () => {
  for (const [rust, browser] of [[true, true], [false, true], [false, false]]) checkAggregate(Boolean(rust), Boolean(browser));
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

function checkAggregate(rust: boolean, browser: boolean): void {
  const valid = results(rust, browser);
  expect(() => requireCiSuccess(valid)).not.toThrow();
  for (const result of producerStates) {
    const candidate = { ...valid, rust: { result: result.rust }, "browser-production": { result: result.browser } };
    const correct = result.rust === (rust ? "success" : "skipped") && result.browser === (browser && !rust ? "success" : "skipped");
    if (correct) expect(() => requireCiSuccess(candidate)).not.toThrow();
    if (!correct) expect(() => requireCiSuccess(candidate)).toThrow();
  }
  for (const id of ["rust", "browser-production"]) {
    const missing = { ...valid };
    delete missing[id];
    expect(() => requireCiSuccess(missing)).toThrow();
  }
}

test("both routes share effective tools, producer environment and one implementation", () => {
  expect(job("browser-production").env).toEqual(job("rust").env);
  for (const id of ["rust", "browser-production"]) {
    const entries = steps(job(id));
    const setup = entries.find(step => step.uses === "./.github/actions/native-setup");
    const produce = entries.find(step => step.uses === "./.github/actions/native-production");
    expect(setup).toBeDefined();
    expect(produce).toBeDefined();
    expect(object(setup!.with)["node-version"]).toBe("${{ env.CI_NODE_VERSION }}");
    expect(object(setup!.with)["jsc-manifest"]).toBe("${{ needs.jsc-prebuild.outputs.manifest-sha256 }}");
    expect(JSON.stringify(entries)).not.toContain("bash scripts/build-bun-browser.sh");
  }
  const producer = read(".github/actions/native-production/action.yml");
  for (const command of ["BROWSER_CARGO_TARGET_DIR=\"$CARGO_TARGET_DIR\" JOBS=4 bash scripts/build-bun-browser.sh", "TOOLS_CARGO_TARGET_DIR=\"$CARGO_TARGET_DIR\" JOBS=4 bash scripts/build-bun-tools.sh", "CARGO_BUILD_JOBS=3 bash scripts/build.sh", "CARGO_BUILD_JOBS=3 bash scripts/build-bun-spidermonkey.sh"]) expect(producer.split(command)).toHaveLength(2);
  const alternate = JSON.stringify(steps(job("browser-production", true)));
  for (const forbidden of ["quality-rust.ts", "quality:wasi", "ci-native-handoff.ts", "test-checks.ts native", "ordinary-spidermonkey-program", "ordinary-jsc-program", "native-profile-launcher"]) expect(alternate).not.toContain(forbidden);
  for (const needed of ["build.sh", "build-bun-core.sh", "build-bun-spidermonkey.sh", "build-bun-browser.sh", "build-bun-tools.sh", "build-bash-web-shell.sh", "browser-guest-site.ts build", "ci-browser-program.ts export"]) expect(alternate).toContain(needed);
});

test("seed prepares full sources and standard dependencies while checkpoint imports before TLS and production", () => {
  const alternate = steps(job("browser-production", true));
  const commands = JSON.stringify(alternate);
  expect(commands).toContain("bash scripts/sync-bun.sh\\nbash scripts/sync-crypto.sh");
  expect(commands).not.toMatch(/sync-bun.sh --(?:check|source-only)/);
  expect(commands.indexOf("Prepare pinned upstream sources")).toBeLessThan(commands.indexOf("Import the verified JSC prebuild"));
  expect(commands.indexOf("Prepare pinned Rust standard-library dependencies")).toBeLessThan(commands.indexOf("Build the common engine core once"));
  const std = named(alternate, "Prepare pinned Rust standard-library dependencies");
  expect(std.run).toContain('"$GUEST_CARGO" fetch --locked --manifest-path "$sysroot/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1');
  const checkpoint = JSON.stringify(steps(job("rust", true)));
  expect(checkpoint).not.toContain("Prepare pinned upstream sources");
  expect(checkpoint).not.toContain("Require empty seed destinations");
  expect(checkpoint).not.toContain('"id":"native-cargo-cache","uses":"actions/cache/restore');
  expect(checkpoint.indexOf("ci-native-handoff.ts unpack")).toBeLessThan(checkpoint.indexOf("Run the blocking TLS native probe"));
  expect(checkpoint.indexOf("Run the blocking TLS native probe")).toBeLessThan(checkpoint.indexOf("Build the common engine core once"));
  expect(read("scripts/ci-native-handoff.ts")).not.toContain("optional-checkpoint");
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

test("alternate reader reuses every existing rust object prefix and release scope with no PR writer", () => {
  const setup = steps(job("browser-production")).find(step => step.uses === "./.github/actions/native-setup");
  expect(object(setup!.with)["cache-scope"]).toBe("rust");
  const objects = read(".github/actions/rust-build-cache/action.yml");
  expect(objects).toContain("default: ${{ github.job }}");
  expect(objects.match(/rust-objects-v[23]-.+\$\{\{ inputs.scope \}\}/g)).toHaveLength(4);
  expect(objects).not.toContain("${{ github.job }}-");
  const setupSteps = steps(action("native-setup"));
  for (const uses of ["./.github/actions/rust-build-cache", "./.github/actions/release-downloads"]) {
    expect(object(setupSteps.find(step => step.uses === uses)!.with).scope).toBe("${{ inputs.cache-scope }}");
  }
  expect(object(job("browser-production").permissions)).toEqual({ contents: "read" });
  for (const step of steps(job("browser-production", true)).filter(step => step.uses === "actions/cache/save@v4")) {
    expect(step.if).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  }
});

test("composite steps use supported metadata and transfers retain their five-minute hang caps", () => {
  for (const name of ["native-setup", "native-seed", "native-production"]) {
    for (const step of steps(action(name))) requireSupportedStep(step);
  }
  for (const id of ["native-quality", "rust", "ordinary-web-guests", "browser-production"]) {
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
