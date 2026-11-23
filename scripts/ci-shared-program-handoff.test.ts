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
const consumerRunner = readFileSync(new URL("./ci-shared-consumer-run.ts", import.meta.url), "utf8");
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

test("SpiderMonkey diagnostics leave upload time inside the job bound and preserve failure", () => {
  const deadline = namedStep("Reserve time for shared producer diagnostics");
  expect(deadline.run).toContain("52 * 60 * 1000");
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

test("two consumer runners verify same-source inputs inline and cover all six shared checks", () => {
  expect(jobs["shared-native"]).toBeUndefined();
  expect(jobs["shared-browser"]).toBeUndefined();
  const job = record(jobs["shared-consumers"]);
  expect(job.needs).toEqual(["selection", "ordinary-build", "shared-sysroot"]);
  expect(job.if).toContain(selection);
  expect(record(job.strategy)).toEqual({ "fail-fast": false, matrix: { group: ["quickjs-jsc", "spidermonkey"] } });
  const body = steps(job);
  const commands = body.map(step => String(step.run ?? "")).join("\n");
  expect(commands).toContain('bun scripts/ci-shared-proof-inputs.ts prepare "$RUNNER_TEMP/shared-proof-inputs" "$programs" "$RUNNER_TEMP/shared-playground-site"');
  expect(commands).toContain('bun scripts/ci-shared-proof-inputs.ts verify "$RUNNER_TEMP/shared-proof-inputs"');
  expect(commands).toContain('bun scripts/ci-shared-consumer-run.ts "${{ matrix.group }}"');
  expect(commands).not.toMatch(/build-native-profile|build-bun|build-jsc|buildSite|browser-guest-site.ts build/);
  expect(job["continue-on-error"]).toBeUndefined();
  expect(consumerRunner).toContain('"native", "--profile", "shared-group"');
  expect(consumerRunner).toContain('"browser-guest", "--profile", "shared-group"');
  expect(consumerRunner).toContain("sharedBrowserClocks(engine).consumerSeconds");
  expect(consumerRunner).toContain("Shared native process cleanup could not be confirmed");
  expect(shared.needs).toBe("selection");
  expect(shared.if).toContain("needs.selection.outputs.shared == 'true' || needs.selection.outputs.shared-native == 'true'");
  expect(shared["timeout-minutes"]).toBe(55);
  expect(shared.name).toBe("Shared PIC program producer");
  expect(sharedSteps.some(step => String(step.run).includes("test-checks.ts"))).toBe(false);
  expect(namedStep("Produce the shared JSC profile once").env).toEqual({ JSC_PROFILE: "shared-group", JOBS: "2", CAGE: "" });
});

test("consumer scratch remains isolated on the runner after sourcing workstation defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-consumer-env-"));
  const probe = 'source env.sh\n"$BUN_BIN" -e \'const {tmpdir}=require("node:os");const {mkdtempSync,rmSync}=require("node:fs");const {join}=require("node:path");if(tmpdir()!==process.env.RUNNER_TEMP)throw Error("Wrong consumer scratch");const path=mkdtempSync(join(tmpdir(),"probe-"));rmSync(path,{recursive:true});\'';
  const execute = (env: NodeJS.ProcessEnv) => spawnSync("bash", ["-euo", "pipefail", "-c", probe], { cwd: resolve(import.meta.dir, ".."), env, encoding: "utf8" });
  try {
    const legacy: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: root, BUN_BIN: process.execPath };
    for (const name of ["TMPDIR", "TMP", "TEMP"]) delete legacy[name];
    expect(execute(legacy).status).not.toBe(0);
    expect(consumerRunner).toContain("TMPDIR: scratch");
    expect(consumerRunner).toContain("TMP: scratch");
    expect(consumerRunner).toContain("TEMP: scratch");
    const scratch = join(root, "shared-quickjs-browser");
    mkdirSync(scratch, { recursive: true });
    const result = execute({ ...legacy, RUNNER_TEMP: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the matching native launcher stays in its original source-verified artifact", () => {
  const launchers = allSteps.filter(step => step.with && record(step.with).name === "native-profile-launcher");
  expect(launchers).toHaveLength(4);
  expect(launchers.map(step => step.uses)).toEqual([
    "actions/upload-artifact@v4",
    "actions/download-artifact@v4",
    "actions/download-artifact@v4",
    "actions/download-artifact@v4",
  ]);
  const prepare = steps(record(jobs["shared-consumers"])).find(step => step.name === "Prepare and verify same-source shared proof inputs");
  expect(String(prepare?.run)).toContain('test "$(cat "$RUNNER_TEMP/native-profile-launcher/source.txt")" = "$GITHUB_SHA"');
  expect(String(prepare?.run)).toContain('chmod +x "$RUNNER_TEMP/native-profile-launcher/bun-wasm"');
});

test("shared consumer runner enforces per-engine Browser caps and cleanup receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-shared-runner-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const mockBun = [
      "#!/bin/bash",
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [[ "${REAL_SUPERVISOR:-0}" == 1 && "$1" == */run-with-timeout.mts ]]; then',
      '  if [[ "$2" == --state ]]; then',
      '    exec "$REAL_BUN" "$1" --state "$3" "$4" true',
      "  fi",
      '  exec "$REAL_BUN" "$1" "$2" true',
      "fi",
      'if [[ "${WRITE_STATUS:-1}" == 1 && "$2" == --state ]]; then',
      '  printf "0\\n" > "$3/status"',
      "fi",
    ].join("\n") + "\n";
    writeFileSync(join(bin, "bun"), mockBun, { mode: 0o755 });
    const recordPath = join(root, "record");
    const now = Math.floor(Date.now() / 1000);
    const run = (group: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [new URL("./ci-shared-consumer-run.ts", import.meta.url).pathname, group], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_BUN: process.execPath, RUNNER_TEMP: root, SHARED_PROOF_INPUTS_DIR: join(root, "inputs"), BUN_WASM_LAUNCHER: join(root, "bun-wasm"), SHARED_STARTED: String(now), SHARED_CHECK_SECONDS: "1800", RECORD: recordPath, ...extra },
      encoding: "utf8",
    });
    // Exercise the real Linux run-with-timeout.mts --state receipt handoff end-to-end.
    const realQjsJsc = run("quickjs-jsc", { REAL_SUPERVISOR: "1" });
    expect(realQjsJsc.status, realQjsJsc.stdout + realQjsJsc.stderr).toBe(0);
    const qjsLines = readFileSync(recordPath, "utf8").trim().split("\n");
    expect(qjsLines.filter(line => line.includes("native --profile shared-group"))).toHaveLength(2);
    expect(qjsLines.filter(line => line.includes("900 bun") && line.includes("browser-guest --profile shared-group"))).toHaveLength(2);
    writeFileSync(recordPath, "");
    const sm = run("spidermonkey", { REAL_SUPERVISOR: "1" });
    expect(sm.status, sm.stdout + sm.stderr).toBe(0);
    const smLines = readFileSync(recordPath, "utf8").trim().split("\n");
    expect(smLines.some(line => line.includes("native --profile shared-group"))).toBe(true);
    expect(smLines.some(line => line.includes("1320 bun") && line.includes("browser-guest --profile shared-group"))).toBe(true);
    // If the native supervisor fails to write its cleanup status receipt, Browser fails closed without starting.
    writeFileSync(recordPath, "");
    const unconfirmed = run("quickjs-jsc", { WRITE_STATUS: "0" });
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stdout).toContain("Shared native process cleanup could not be confirmed");
    expect(readFileSync(recordPath, "utf8")).not.toContain("browser-guest --profile shared-group");
    const expired = run("spidermonkey", { SHARED_STARTED: String(now - 2000) });
    expect(expired.status).toBe(1);
    expect(expired.stdout).toContain("exhausted its budget");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff contracts have exactly one existing blocking source-check owner", () => {
  expect(discoverChecks().filter(check => check.path === "scripts/ci-shared-program-handoff.test.ts"))
    .toEqual([{ owner: "quality", path: "scripts/ci-shared-program-handoff.test.ts", localRuntime: false, batch: "default" }]);
});
