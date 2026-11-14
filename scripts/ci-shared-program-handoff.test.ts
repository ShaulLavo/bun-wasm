import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { programProfile } from "../src/engine-kind.ts";
import { discoverChecks } from "./test-checks.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const workflow = record(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const jobs = record(workflow.jobs);
const shared = record(jobs["shared-sysroot"]);
const builder = readFileSync(new URL("./build-native-profile.ts", import.meta.url), "utf8");
const selection = "needs.quality.outputs.shared-native == 'true'";
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

test("QuickJS is retained before its consumers or the later JSC producer can fail", () => {
  const upload = sharedSteps.indexOf(uploadFor("quickjs"));
  for (const name of ["Prepare the same-source shared proof handoff", "Produce the shared JSC profile once"]) {
    expect(upload).toBeLessThan(sharedSteps.indexOf(namedStep(name)));
  }
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

test("native and Browser consumers use ready artifacts on separate runners and discover checks once per engine", () => {
  for (const id of ["shared-native", "shared-browser"]) {
    const job = record(jobs[id]);
    expect(job.needs).toContain("shared-sysroot");
    expect(job.if).toContain("!cancelled() && needs.quality.result == 'success'");
    expect(job.if).toContain(selection);
    expect(job["timeout-minutes"]).toBe(30);
    expect(record(job.strategy)).toEqual({ "fail-fast": false, matrix: { engine: ["quickjs", "jsc", "spidermonkey"] } });
    const body = steps(job);
    expect(body.filter(step => step.with && record(step.with).name === "shared-proof-inputs")).toHaveLength(1);
    const commands = body.map(step => String(step.run ?? "")).join("\n");
    expect(commands).toContain('bun scripts/ci-shared-proof-inputs.ts verify "$RUNNER_TEMP/shared-proof-inputs"');
    expect(commands).toContain("shared-proof-inputs/program-${{ matrix.engine }}/bun.wasm");
    expect(commands).not.toMatch(/build-native-profile|build-bun|build-jsc|buildSite|browser-guest-site.ts build/);
    expect(job["continue-on-error"]).toBeUndefined();
    const owner = id === "shared-native" ? "native" : "browser-guest";
    expect(commands.match(new RegExp(`test-checks.ts ${owner} --profile shared-group`, "g"))).toHaveLength(1);
    if (id === "shared-browser") expect(commands).toContain("run-with-timeout.mts ${{ matrix.engine == 'spidermonkey' && 660 || 420 }} bun scripts/test-checks.ts");
    else expect(commands).toContain('export BUN_WASM_LAUNCHER="$RUNNER_TEMP/native-profile-launcher/bun-wasm"');
  }
  expect(shared["timeout-minutes"]).toBe(30);
  expect(shared.name).toBe("Shared PIC program producer");
  expect(sharedSteps.some(step => String(step.run).includes("test-checks.ts"))).toBe(false);
  expect(namedStep("Produce the shared JSC profile once").env).toEqual({ JSC_PROFILE: "shared-group", JOBS: "2", CAGE: "" });
});

test("consumer scratch remains on the runner after sourcing workstation defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-consumer-env-"));
  const probe = 'source env.sh\n"$BUN_BIN" -e \'const {tmpdir}=require("node:os");const {mkdtempSync,rmSync}=require("node:fs");const {join}=require("node:path");if(tmpdir()!==process.env.RUNNER_TEMP)throw Error("Wrong consumer scratch");const path=mkdtempSync(join(tmpdir(),"probe-"));rmSync(path,{recursive:true});\'';
  const execute = (env: NodeJS.ProcessEnv) => spawnSync("bash", ["-euo", "pipefail", "-c", probe], { cwd: resolve(import.meta.dir, ".."), env, encoding: "utf8" });
  try {
    const legacy: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: root, BUN_BIN: process.execPath };
    for (const name of ["TMPDIR", "TMP", "TEMP"]) delete legacy[name];
    expect(execute(legacy).status).not.toBe(0);
    for (const id of ["shared-native", "shared-browser"]) {
      const consumer = steps(record(jobs[id])).find(step => String(step.name).startsWith("Consume the discovered shared "))!;
      expect(consumer.env).toEqual({ TMPDIR: "${{ runner.temp }}", TMP: "${{ runner.temp }}", TEMP: "${{ runner.temp }}" });
      const env = { ...legacy, ...Object.fromEntries(Object.keys(record(consumer.env)).map(name => [name, root])) };
      const result = execute(env);
      expect(result.status, result.stderr).toBe(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the matching native launcher stays in its original source-verified artifact", () => {
  const launchers = allSteps.filter(step => step.with && record(step.with).name === "native-profile-launcher");
  expect(launchers).toHaveLength(2);
  expect(launchers.map(step => step.uses)).toEqual(["actions/upload-artifact@v4", "actions/download-artifact@v4"]);
  const native = steps(record(jobs["shared-native"]));
  expect(native.find(step => step.name === "Verify the native launcher source")?.run).toBe('test "$(cat "$RUNNER_TEMP/native-profile-launcher/source.txt")" = "$GITHUB_SHA"\nchmod +x "$RUNNER_TEMP/native-profile-launcher/bun-wasm"\n');
});

test("the protected proof requires every selected producer and consumer, including disabled skips", () => {
  const guard = record(jobs["shared-proof"]);
  expect(guard.name).toBe("Shared PIC sysroot proof");
  expect(guard.needs).toEqual(["quality", "rust", "shared-prebuild", "shared-spidermonkey-prebuild", "shared-sysroot", "shared-native", "shared-browser"]);
  expect(guard.if).toContain("always()");
  expect(guard["continue-on-error"]).toBeUndefined();
  const check = steps(guard)[0]!;
  expect(check.if).toBeUndefined();
  expect(check["continue-on-error"]).toBeUndefined();
  if (typeof check.run !== "string") throw new Error("Missing final proof guard");
  const base = { QUALITY_RESULT: "success", SHARED_PREBUILD_RESULT: "success", SHARED_PRODUCER_RESULT: "success", SHARED_NATIVE: "true", RUST_RESULT: "success", SM_RESULT: "success", NATIVE_RESULT: "success", BROWSER_RESULT: "success" };
  const run = (env: Record<string, string>) => spawnSync("bash", ["-euo", "pipefail", "-c", String(check.run)], { env: { ...process.env, ...env } }).status;
  expect(run(base)).toBe(0);
  const disabled = { ...base, SHARED_NATIVE: "false", RUST_RESULT: "skipped", SM_RESULT: "skipped", NATIVE_RESULT: "skipped", BROWSER_RESULT: "skipped" };
  expect(run(disabled)).toBe(0);
  for (const field of Object.keys(base).filter(field => field !== "SHARED_NATIVE")) {
    for (const status of ["failure", "cancelled", "skipped", ""]) expect(run({ ...base, [field]: status })).not.toBe(0);
  }
  for (const field of ["SM_RESULT", "NATIVE_RESULT", "BROWSER_RESULT"]) expect(run({ ...disabled, [field]: "success" })).not.toBe(0);
  expect(run({ ...base, SHARED_NATIVE: "" })).not.toBe(0);
});

test("handoff contracts have exactly one existing blocking source-check owner", () => {
  expect(discoverChecks().filter(check => check.path === "scripts/ci-shared-program-handoff.test.ts"))
    .toEqual([{ owner: "quality", path: "scripts/ci-shared-program-handoff.test.ts", localRuntime: false, batch: "default" }]);
});
