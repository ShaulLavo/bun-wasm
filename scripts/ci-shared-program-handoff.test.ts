import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  for (const name of ["Consume the shared native feature checks", "Consume the shared Browser feature checks", "Produce the shared JSC profile once"]) {
    expect(upload).toBeLessThan(sharedSteps.indexOf(namedStep(name)));
  }
});

test("exports use exactly the selected engine producers and never add a receipt writer", () => {
  const producers = exports.map(output => namedStep(output.producer))
    .concat([namedStep("Produce the shared SpiderMonkey profile once")]);
  expect(allSteps.filter(step => typeof step.run === "string" && step.run.includes("scripts/build-native-profile.ts")))
    .toEqual(producers);
  expect(producers[2]!.run).toBe('source env.sh\nbun scripts/build-native-profile.ts shared-group "$CARGO_TARGET_DIR/shared-native" spidermonkey\n');
  const engines: string[] = exports.map(output => output.engine);
  for (const engine of engines.concat(["spidermonkey"])) {
    expect(Object.keys(uploadFor(engine)).sort()).toEqual(["if", "name", "timeout-minutes", "uses", "with"]);
    expect(uploadFor(engine)["timeout-minutes"]).toBe(5);
  }
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
  expect(builder).toContain("writeFileSync(join(program, 'source.txt'), head.stdout);\n  return program;");
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

test("native and Chromium consumers retain their selection, profile, launcher and blocking commands", () => {
  const common = "source env.sh\nexport BUN_WASM_PROFILE_PROGRAM=\"$CARGO_TARGET_DIR/shared-native/";
  const launcher = 'export BUN_WASM_LAUNCHER="$RUNNER_TEMP/native-profile-launcher/bun-wasm"\nexport BUN_WASM_TRACE=1\n';
  const native = "bun scripts/test-checks.ts native --profile shared-group\n";
  const browser = "bun scripts/run-with-timeout.mts 420 bun scripts/test-checks.ts browser-guest --profile shared-group\n";
  const consumers = [
    { name: "Consume the shared native feature checks", run: `${common}program/bun.wasm"\n${launcher}${native}` },
    { name: "Consume the shared Browser feature checks", run: 'source env.sh\nbun "$GITHUB_WORKSPACE/scripts/ci-install.ts" --cwd web --frozen-lockfile --ignore-scripts\n(cd web && bun scripts/ci-browser-deps.ts chromium && bunx playwright install chromium)\nexport BUN_WASM_PROFILE_PROGRAM="$CARGO_TARGET_DIR/shared-native/program/bun.wasm"\n' + browser },
    { name: "Consume the shared JSC feature checks", run: `${common}program-jsc/bun.wasm"\n${launcher}${native}${browser}` },
  ];
  for (const consumer of consumers) {
    const condition = consumer.name === "Consume the shared JSC feature checks" ? "${{ !cancelled() && needs.quality.outputs.shared-native == 'true' }}" : selection;
    expect(namedStep(consumer.name)).toEqual({ name: consumer.name, if: condition, run: consumer.run });
  }
  expect(shared.needs).toEqual(["quality", "rust", "shared-prebuild", "shared-spidermonkey-prebuild"]);
  expect(shared.if).toBe("${{ (github.event_name != 'pull_request' || !github.event.pull_request.draft) && !cancelled() && needs.quality.result == 'success' && (needs.quality.outputs.shared == 'true' || needs.quality.outputs.shared-native == 'true') }}");
  expect(shared["timeout-minutes"]).toBe(30);
  expect(namedStep("Produce the shared JSC profile once").env).toEqual({ JSC_PROFILE: "shared-group", JOBS: "2", CAGE: "" });
});

test("the matching native launcher stays in its own original source-verified artifact", () => {
  const launchers = allSteps.filter(step => step.with && record(step.with).name === "native-profile-launcher");
  expect(launchers).toHaveLength(2);
  expect(launchers.map(step => step.uses)).toEqual(["actions/upload-artifact@v4", "actions/download-artifact@v4"]);
  expect(namedStep("Verify the native launcher source").run).toBe('test "$(cat "$RUNNER_TEMP/native-profile-launcher/source.txt")" = "$GITHUB_SHA"\nchmod +x "$RUNNER_TEMP/native-profile-launcher/bun-wasm"\n');
  expect(namedStep("Require the shared native launcher producer").run).toBe('test "$PROFILE_LAUNCHER_RESULT" = success\n');
});

test("handoff contracts have exactly one existing blocking source-check owner", () => {
  expect(discoverChecks().filter(check => check.path === "scripts/ci-shared-program-handoff.test.ts"))
    .toEqual([{ owner: "quality", path: "scripts/ci-shared-program-handoff.test.ts", localRuntime: false, batch: "default" }]);
});
