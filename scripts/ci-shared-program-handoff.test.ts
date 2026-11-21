import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { programProfile } from "../src/engine-kind.ts";
import { discoverChecks } from "./test-checks.ts";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const workflow = record(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = record(workflow.jobs);
const shared = record(jobs["shared-sysroot"]);
const builder = readFileSync(new URL("./build-native-profile.ts", import.meta.url), "utf8");
const selection = "needs.selection.outputs.shared-native == 'true'";
const exports = [
  { engine: "quickjs", id: "shared-quickjs-producer", directory: "program", producer: "Produce the shared native profile once", argument: "" },
  { engine: "jsc", id: "shared-jsc-producer", directory: "program-jsc", producer: "Produce the shared JSC profile once", argument: " jsc" },
] as const;

function steps(job: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) throw new Error("Expected job steps");
  return job.steps.map(record);
}

const sharedSteps = steps(shared);
const allSteps = Object.values(jobs).flatMap(job => steps(record(job)));

function consumerStep(name: string): Record<string, unknown> {
  const step = steps(record(jobs["shared-consumers"])).find(step => step.id === name || step.name === name);
  if (!step) throw new Error(`Missing shared consumer step: ${name}`);
  return step;
}

function namedStep(name: string): Record<string, unknown> {
  const matches = sharedSteps.filter(step => step.name === name);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function uploadFor(engine: string): Record<string, unknown> {
  const named = (step: Record<string, unknown>) => step.with && record(step.with).name === `shared-${engine}-program`;
  const matches = sharedSteps.filter(named);
  expect(matches).toHaveLength(1);
  expect(allSteps.filter(named)).toEqual(matches);
  return matches[0]!;
}

function retained(condition: unknown, id: string, outcome: string, downstreamFailed: boolean): boolean {
  if (typeof condition !== "string") throw new Error("Expected artifact condition");
  const explicitStatus = /\b(?:always|success|failure|cancelled)\(\)/.test(condition);
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("always()", "true")
    .replaceAll("success()", String(!downstreamFailed))
    .replaceAll(`steps.${id}.outcome`, JSON.stringify(outcome));
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw new Error("Non-boolean artifact condition");
  return (explicitStatus || !downstreamFailed) && result;
}

for (const output of exports) {
  test(`${output.engine} retains exactly the complete existing producer directory for one day`, () => {
    const producer = namedStep(output.producer);
    const command = `source env.sh\nbun scripts/build-native-profile.ts shared-group "$CARGO_TARGET_DIR/shared-native"${output.argument}\n`;
    expect(producer.id).toBe(output.id);
    expect(allSteps.filter(step => step.id === output.id)).toEqual([producer]);
    expect(allSteps.filter(step => step.run === command)).toEqual([producer]);
    expect(producer.run).toBe(command);
    expect(producer.if).toBe(selection);
    expect(producer["continue-on-error"]).toBeUndefined();
    const upload = uploadFor(output.engine);
    expect(upload.uses).toBe("actions/upload-artifact@v4");
    expect(upload.with).toEqual({
      name: `shared-${output.engine}-program`,
      path: `\${{ env.CARGO_TARGET_DIR }}/shared-native/${output.directory}/`,
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    expect(upload.if).toBe(`\${{ always() && steps.${output.id}.outcome == 'success' }}`);
    expect(upload.run).toBeUndefined();
    expect(upload.env).toBeUndefined();
    expect(upload["continue-on-error"]).toBeUndefined();
    expect(sharedSteps.indexOf(upload)).toBeGreaterThan(sharedSteps.indexOf(producer));
    expect(sharedSteps.indexOf(upload)).toBeLessThan(sharedSteps.indexOf(namedStep("Save the completed shared native profile")));
  });

  test(`${output.engine} upload survives a failed consumer but never publishes a failed or skipped producer`, () => {
    const upload = uploadFor(output.engine);
    for (const downstreamFailed of [false, true]) {
      expect(retained(upload.if, output.id, "success", downstreamFailed)).toBe(true);
      expect(retained(upload.if, output.id, "failure", downstreamFailed)).toBe(false);
      expect(retained(upload.if, output.id, "cancelled", downstreamFailed)).toBe(false);
      expect(retained(upload.if, output.id, "skipped", downstreamFailed)).toBe(false);
    }
    expect(retained(`steps.${output.id}.outcome == 'success'`, output.id, "success", true)).toBe(false);
    expect(retained(`\${{ success() && steps.${output.id}.outcome == 'success' }}`, output.id, "success", true)).toBe(false);
  });
}

test("QuickJS is retained before the later JSC producer can fail", () => {
  const upload = sharedSteps.indexOf(uploadFor("quickjs"));
  expect(upload).toBeLessThan(sharedSteps.indexOf(namedStep("Produce the shared JSC profile once")));
});

test("exports use exactly the selected engine producers and never add a receipt writer", () => {
  const producers = exports.map(output => namedStep(output.producer))
    .concat([namedStep("Produce the shared SpiderMonkey profile once")]);
  expect(allSteps.filter(step => typeof step.run === "string" && step.run.includes("scripts/build-native-profile.ts")))
    .toEqual(producers);
  expect(producers[2]!.run).toBe('source env.sh\nbun scripts/producer-diagnostics.ts run "$RUNNER_TEMP/shared-spidermonkey-producer" "$SHARED_PRODUCER_DEADLINE_MS" \\\n  bash scripts/with-build-cache.sh bun scripts/build-native-profile.ts shared-group "$CARGO_TARGET_DIR/shared-native" spidermonkey\n');
  const engines: string[] = exports.map(output => output.engine);
  for (const engine of engines.concat(["spidermonkey"])) {
    expect(Object.keys(uploadFor(engine)).sort()).toEqual(["if", "name", "timeout-minutes", "uses", "with"]);
    expect(uploadFor(engine)["timeout-minutes"]).toBe(5);
  }
});

test("SpiderMonkey diagnostics leave upload time inside the existing job bound and preserve failure", () => {
  const deadline = namedStep("Reserve time for shared producer diagnostics");
  expect(deadline.run).toContain("27 * 60 * 1000");
  expect(sharedSteps.indexOf(deadline)).toBe(0);
  const producer = namedStep("Produce the shared SpiderMonkey profile once");
  expect(producer["continue-on-error"]).toBeUndefined();
  const upload = namedStep("Retain shared SpiderMonkey producer diagnostics");
  expect(upload.if).toBe("${{ always() && steps.shared-spidermonkey-producer.outcome != 'skipped' }}");
  expect(upload["timeout-minutes"]).toBe(2);
  expect(record(upload.with).path).toBe("${{ runner.temp }}/shared-spidermonkey-producer/");
  expect(sharedSteps.indexOf(upload)).toBe(sharedSteps.indexOf(producer) + 1);
  expect(sharedSteps.indexOf(namedStep("Shared profile cache result"))).toBeLessThan(sharedSteps.indexOf(producer));
});

test("successful production writes the original core, side, receipts and source before returning", () => {
  expect(builder).toContain("const program = join(root, engine === 'quickjs' ? 'program' : `program-${engine}`);");
  expect(builder).toContain("run(['bun', 'scripts/guest-core-receipt.ts', 'tag', join(core, 'bun-core.wasm'), engine, join(program, 'bun.wasm')]);");
  expect(builder).toContain("const companion = programProfile(engine).side;");
  expect(builder).toContain("copyFileSync(join(side, 'engine.wasm'), join(program, companion));");
  expect(builder).toContain("copyFileSync(join(side, 'engine.wasm.engine.json'), join(program, `${companion}.engine.json`));");
  expect(builder).toContain("copyFileSync(join(core, 'bun-core.wasm.core.json'), join(program, 'bun-core.wasm.core.json'));");
  expect(builder).toContain("const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' });");
  expect(builder).toContain("if (head.status !== 0) throw new Error('Cannot identify native profile source');");
  expect(builder).toContain("writeFileSync(join(program, 'source.txt'), head.stdout);");
  expect(builder).toContain("writeFileSync(join(program, 'current-inputs.json'), JSON.stringify(inputs, null, 2) + '\\n');\n  return program;");
  for (const fragment of [
    "await prepareProgramOutputs([",
    "{ artifact: join(core, 'bun-core.wasm'), scope: 'core', selection: { features: ['engine-split', 'bun-transpiler', 'bun-build'], profile: 'shared-group' }, options: sourceOptions(repository, sysroot, 'browser') }",
    "{ artifact: join(side, 'engine.wasm'), scope: engine, profile: 'shared-group', options: sourceOptions(repository, sysroot, engine) }",
    "'scripts/build-bun-core.sh', '--shared-group'",
  ]) {
    expect(builder).toContain(fragment);
  }
  expect(exports.map(output => programProfile(output.engine).side)).toEqual(["quickjs.wasm", "jsc-engine.wasm"]);
});

test("four runners verify the ready inputs once per runner and cover all six shared checks", () => {
  expect(jobs["shared-native"]).toBeUndefined();
  expect(jobs["shared-browser"]).toBeUndefined();
  const job = record(jobs["shared-consumers"]);
  expect(job.needs).toEqual(["selection", "ordinary-web-guests", "rust"]);
  expect(job.if).toContain("!cancelled() && needs.selection.result == 'success'");
  expect(job.if).toContain("needs.ordinary-web-guests.outputs.shared-proof-inputs == 'success'");
  expect(job.if).toContain(selection);
  expect(record(job.strategy)).toEqual({ "fail-fast": false, matrix: { include: [
    { engine: "quickjs", native: true, browser: true },
    { engine: "jsc", native: true, browser: true },
    { engine: "spidermonkey", native: true, browser: false },
    { engine: "spidermonkey", native: false, browser: true },
  ] } });
  const body = steps(job);
  expect(body.filter(step => step.with && record(step.with).name === "shared-proof-inputs")).toMatchObject([{ "timeout-minutes": 5 }]);
  const commands = body.map(step => String(step.run ?? "")).join("\n");
  expect(commands).toContain('bun scripts/ci-shared-proof-inputs.ts verify "$RUNNER_TEMP/shared-proof-inputs"');
  expect(commands).toContain("shared-proof-inputs/program-${{ matrix.engine }}/bun.wasm");
  expect(commands).toContain('export BUN_WASM_LAUNCHER="$RUNNER_TEMP/native-profile-launcher/bun-wasm"');
  expect(commands).not.toMatch(/build-native-profile|build-bun|build-jsc|buildSite|browser-guest-site.ts build/);
  expect(job["continue-on-error"]).toBeUndefined();
  for (const owner of ["native", "browser-guest"]) {
    expect(commands.match(new RegExp(`test-checks.ts ${owner} --profile shared-group`, "g"))).toHaveLength(1);
  }
  expect(shared.needs).toEqual(["selection", "shared-prebuild", "shared-spidermonkey-prebuild"]);
  expect(shared.if).toContain("needs.selection.outputs.shared == 'true' || needs.selection.outputs.shared-native == 'true'");
  expect(shared["timeout-minutes"]).toBe(30);
  expect(shared.name).toBe("Shared PIC program producer");
  expect(sharedSteps.some(step => String(step.run).includes("test-checks.ts"))).toBe(false);
  expect(namedStep("Produce the shared JSC profile once").env).toEqual({ JSC_PROFILE: "shared-group", JOBS: "2", CAGE: "" });
});

type Lane = { native: boolean; browser: boolean };
type StepResults = Record<string, string>;

function stepEnabled(step: Record<string, unknown>, lane: Lane, outcomes: StepResults, failed = false, cancelled = false): boolean {
  if (typeof step.if !== "string") return !failed && !cancelled;
  const status = /\b(?:always|success|failure|cancelled)\(\)/.test(step.if);
  const expression = step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("cancelled()", String(cancelled)).replaceAll("failure()", String(failed))
    .replaceAll("matrix.native", String(lane.native)).replaceAll("matrix.browser", String(lane.browser))
    .replace(/steps\.([\w-]+)\.outcome/g, (_match, id: string) => JSON.stringify(outcomes[id] ?? ""));
  return (status || !failed && !cancelled) && new Function(`return (${expression})`)() === true;
}

function consumerStepsRun(lane: Lane, failures: StepResults = {}): StepResults {
  const entries = steps(record(jobs["shared-consumers"]));
  const results: StepResults = {};
  for (const [index, step] of entries.entries()) {
    const id = String(step.id ?? step.name ?? index);
    const outcomes = Object.values(results);
    const enabled = stepEnabled(step, lane, results, outcomes.includes("failure"), outcomes.includes("cancelled"));
    results[id] = enabled ? failures[id] ?? "success" : "skipped";
  }
  return results;
}

test("the actual step conditions preserve launcher, Browser setup and independent checks", () => {
  const paired = { native: true, browser: true };
  expect(consumerStepsRun(paired)).toMatchObject({ "native-checks": "success", "browser-checks": "success" });
  expect(consumerStepsRun({ native: true, browser: false })).toMatchObject({ "native-checks": "success", "browser-checks": "skipped" });
  expect(consumerStepsRun({ native: false, browser: true })).toMatchObject({ "native-checks": "skipped", "browser-checks": "success", "Verify the native launcher source": "skipped" });
  expect(consumerStepsRun(paired, { "shared-inputs": "failure" })).toMatchObject({ "native-checks": "skipped", "browser-checks": "skipped" });
  expect(consumerStepsRun(paired, { "Verify the native launcher source": "failure" })).toMatchObject({ "native-checks": "skipped", "browser-checks": "success" });
  expect(consumerStepsRun(paired, { "native-checks": "failure" })).toMatchObject({ "native-checks": "failure", "browser-checks": "success" });
  expect(consumerStepsRun(paired, { "native-checks": "cancelled" })).toMatchObject({ "native-checks": "cancelled", "browser-checks": "skipped" });
  for (const id of ["web-deps", "system-deps", "chromium"]) {
    expect(consumerStepsRun(paired, { [id]: "failure" })).toMatchObject({ "native-checks": "success", "browser-checks": "skipped", "Show kernel memory kills and faults after a failure": "success" });
  }
  expect(consumerStepsRun(paired, { "browser-checks": "failure" })).toMatchObject({ "native-checks": "success", "browser-checks": "failure", "Show kernel memory kills and faults after a failure": "success" });
});

function runConsumerStep(name: string, env: NodeJS.ProcessEnv) {
  const { run } = consumerStep(name);
  if (typeof run !== "string") throw new Error(`Missing shell body: ${name}`);
  return spawnSync("bash", ["-euo", "pipefail", "-c", run], { env: { ...process.env, ...env }, encoding: "utf8" });
}

test("the real matrix verdict requires exact selected and skipped step outcomes", () => {
  const cases = [
    { NATIVE_SELECTED: "true", BROWSER_SELECTED: "true", NATIVE_RESULT: "success", BROWSER_RESULT: "success" },
    { NATIVE_SELECTED: "true", BROWSER_SELECTED: "false", NATIVE_RESULT: "success", BROWSER_RESULT: "skipped" },
    { NATIVE_SELECTED: "false", BROWSER_SELECTED: "true", NATIVE_RESULT: "skipped", BROWSER_RESULT: "success" },
  ];
  for (const env of cases) {
    expect(runConsumerStep("Require the selected shared checks", env).status).toBe(0);
    for (const [key, valid] of Object.entries(env)) {
      const rejected = ["success", "skipped", "cancelled", "failure", ""].filter(value => value !== valid);
      for (const value of rejected) expect(runConsumerStep("Require the selected shared checks", { ...env, [key]: value }).status).not.toBe(0);
    }
  }
});

test("Browser setup rejects a native run without a cleanup receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-native-owner-"));
  try {
    mkdirSync(join(directory, "shared-native-run"));
    const result = runConsumerStep("web-deps", { RUNNER_TEMP: directory });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Shared native process cleanup could not be confirmed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared phases charge setup and keep each Browser command cap", () => {
  const native = consumerStep("native-checks");
  const browser = consumerStep("browser-checks");
  expect(record(browser.env).BROWSER_CHECK_SECONDS).toBe("${{ matrix.engine == 'spidermonkey' && 1320 || 420 }}");
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-shared-deadline-"));
  try {
    const command = join(directory, "bun");
    writeFileSync(command, '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const env = { PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, SHARED_CHECK_SECONDS: "1800", SHARED_SETUP_SECONDS: "12" };
    const now = Math.floor(Date.now() / 1000);
    const nativeRun = runConsumerStep("native-checks", { ...env, SHARED_STARTED: String(now - 1801) });
    expect(nativeRun.status).toBe(124);
    expect(native.run).toContain('run-with-timeout.mts --state "$state" "$remaining"');
    const runBrowser = (seconds: number, cap: number, tag: string) => runConsumerStep("browser-checks", {
      ...env, TMPDIR: join(directory, tag), BROWSER_CHECK_SECONDS: String(cap), SHARED_BROWSER_DEADLINE: String(now + seconds),
    });
    for (const cap of [420, 1320]) {
      const result = runBrowser(1770, cap, `browser-${cap}`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split("\n").slice(0, 3)).toEqual(["scripts/run-with-timeout.mts", String(cap), "bun"]);
    }
    const expired = runBrowser(-60, 420, "expired");
    expect(expired.status).toBe(124);
    expect(expired.stdout).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the ordinary Web job assembles shared inputs once after its existing checks", () => {
  const job = record(jobs["ordinary-web-guests"]);
  const entries = steps(job);
  const start = entries.findIndex(step => step.id === "shared-playground-site");
  expect(start).toBeGreaterThan(entries.findIndex(step => step.name === "Retain ordinary Web guest diagnostics"));
  const assembly = entries.slice(start);
  expect(job.needs).toEqual(["selection", "rust", "shared-sysroot"]);
  expect(assembly.filter(step => step.uses === "actions/download-artifact@v4").map(step => step.with)).toEqual([
    { name: "browser-guest-site", path: "${{ runner.temp }}/shared-playground-site" },
    { pattern: "shared-*-program", path: "${{ runner.temp }}/shared-program-downloads" },
  ]);
  const prepare = assembly.find(step => step.name === "Prepare the same-source shared proof handoff");
  const output = assembly.at(-1);
  if (!prepare || !output) throw new Error("Missing shared handoff steps");
  expect(allSteps.filter(step => String(step.run).includes("ci-shared-proof-inputs.ts prepare"))).toEqual([prepare]);
  const uploads = allSteps.filter(step => step.uses === "actions/upload-artifact@v4" && record(step.with).name === "shared-proof-inputs");
  expect(uploads).toEqual([output]);
  expect(output.with).toMatchObject({ "if-no-files-found": "error" });
  const outputs = record(job.outputs);
  expect(outputs["shared-proof-inputs"]).toBe("${{ steps.upload-shared-proof-inputs.outcome }}");
  for (const step of assembly) {
    expect(step.if).toBe("needs.selection.outputs.shared-native == 'true' && needs.shared-sysroot.result == 'success'");
    expect(step["continue-on-error"]).toBeUndefined();
    expect(outputs["shared-proof-inputs-failed"]).toContain(`steps.${step.id}.outcome == 'failure'`);
  }
  expect(JSON.stringify(assembly)).not.toMatch(/cargo build|build-native-profile|test-checks|browser-guest-site\.ts build/);
  expect(JSON.stringify(sharedSteps)).not.toContain("browser-guest-site");
});

test("consumer scratch remains on the runner after sourcing workstation defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-consumer-env-"));
  const probe = 'source env.sh\n"$BUN_BIN" -e \'const {tmpdir}=require("node:os");const {mkdtempSync,rmSync}=require("node:fs");const {join}=require("node:path");if(tmpdir()!==process.env.RUNNER_TEMP)throw Error("Wrong consumer scratch");const path=mkdtempSync(join(tmpdir(),"probe-"));rmSync(path,{recursive:true});\'';
  const execute = (env: NodeJS.ProcessEnv) => spawnSync("bash", ["-euo", "pipefail", "-c", probe], { cwd: resolve(import.meta.dir, ".."), env, encoding: "utf8" });
  try {
    const legacy: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: root, BUN_BIN: process.execPath };
    for (const name of ["TMPDIR", "TMP", "TEMP"]) delete legacy[name];
    expect(execute(legacy).status).not.toBe(0);
    const checks = steps(record(jobs["shared-consumers"])).filter(step => String(step.name).startsWith("Consume the discovered shared "));
    const expansions = ["${{ runner.temp }}", "${{ runner.temp }}/shared-web"];
    expect(checks).toHaveLength(expansions.length);
    for (const [index, check] of checks.entries()) {
      const prefix = expansions[index]!;
      expect(check.env).toMatchObject({ TMPDIR: prefix, TMP: prefix, TEMP: prefix });
      const scratch = prefix.replace("${{ runner.temp }}", root);
      mkdirSync(scratch, { recursive: true });
      const result = execute({ ...legacy, RUNNER_TEMP: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch });
      expect(result.status, result.stderr).toBe(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the matching native launcher stays in its original source-verified artifact", () => {
  const launchers = allSteps.filter(step => step.with && record(step.with).name === "native-profile-launcher");
  expect(launchers).toHaveLength(3);
  expect(launchers.map(step => step.uses)).toEqual(["actions/upload-artifact@v4", "actions/download-artifact@v4", "actions/download-artifact@v4"]);
  const native = steps(record(jobs["shared-consumers"]));
  expect(native.find(step => step.name === "Verify the native launcher source")?.run).toBe('test "$(cat "$RUNNER_TEMP/native-profile-launcher/source.txt")" = "$GITHUB_SHA"\nchmod +x "$RUNNER_TEMP/native-profile-launcher/bun-wasm"\n');
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-launcher-source-"));
  try {
    const launcher = join(root, "native-profile-launcher");
    mkdirSync(launcher);
    writeFileSync(join(launcher, "source.txt"), "source-a\n");
    writeFileSync(join(launcher, "bun-wasm"), "launcher\n");
    const verify = (sha: string) => runConsumerStep("Verify the native launcher source", { RUNNER_TEMP: root, GITHUB_SHA: sha });
    expect(verify("source-b").status).not.toBe(0);
    expect(verify("source-a").status).toBe(0);
    expect(readFileSync(join(launcher, "bun-wasm"), "utf8")).toBe("launcher\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the protected proof requires every selected producer and consumer, including disabled skips", () => {
  const guard = record(jobs["shared-proof"]);
  expect(guard.name).toBe("Shared PIC sysroot proof");
  expect(guard.needs).toEqual(["selection", "ordinary-web-guests", "quality", "rust", "shared-prebuild", "shared-spidermonkey-prebuild", "shared-sysroot", "shared-consumers"]);
  expect(guard.if).toContain("always()");
  expect(guard["continue-on-error"]).toBeUndefined();
  const check = steps(guard)[0]!;
  expect(check.if).toBeUndefined();
  expect(check["continue-on-error"]).toBeUndefined();
  if (typeof check.run !== "string") throw new Error("Missing final proof guard");
  const base = { SELECTION_RESULT: "success", QUALITY_RESULT: "success", SHARED_PREBUILD_RESULT: "success", SHARED_PRODUCER_RESULT: "success", SHARED_NATIVE: "true", FULL_SELECTED: "true", ORDINARY_WEB_RESULT: "success", RUST_RESULT: "success", SM_RESULT: "success", INPUTS_RESULT: "success", CONSUMER_RESULT: "success" };
  const run = (env: Record<string, string>) => spawnSync("bash", ["-euo", "pipefail", "-c", String(check.run)], { env: { ...process.env, ...env } }).status;
  expect(run(base)).toBe(0);
  const disabled = { ...base, SHARED_NATIVE: "false", FULL_SELECTED: "false", ORDINARY_WEB_RESULT: "skipped", RUST_RESULT: "skipped", SM_RESULT: "skipped", INPUTS_RESULT: "skipped", CONSUMER_RESULT: "skipped" };
  expect(run(disabled)).toBe(0);
  expect(run({ ...disabled, INPUTS_RESULT: "" })).toBe(0);
  for (const field of Object.keys(base).filter(field => field !== "SHARED_NATIVE" && field !== "FULL_SELECTED")) {
    for (const status of ["failure", "cancelled", "skipped", ""]) expect(run({ ...base, [field]: status })).not.toBe(0);
  }
  for (const field of ["SM_RESULT", "INPUTS_RESULT", "CONSUMER_RESULT"]) expect(run({ ...disabled, [field]: "success" })).not.toBe(0);
  expect(run({ ...base, SHARED_NATIVE: "" })).not.toBe(0);
});

test("handoff contracts have exactly one existing blocking source-check owner", () => {
  expect(discoverChecks().filter(check => check.path === "scripts/ci-shared-program-handoff.test.ts"))
    .toEqual([{ owner: "quality", path: "scripts/ci-shared-program-handoff.test.ts", localRuntime: false, batch: "default" }]);
});
