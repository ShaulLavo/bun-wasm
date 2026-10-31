import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsHermes, needsRust } from "./ci-changes.ts";
import { discoverChecks } from "./test-checks.ts";
import { captureProgramInputs, verifyProgramReceipt, type ProgramBuildReceipt } from "./guest-core-receipt.ts";
import { artifactIdentity } from "./guest-build-receipt.ts";
import { appendCustomSection, ENGINE_SECTION } from "../src/engine-kind.ts";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";
import { withReceiptFixture } from "../tests/package/guest-receipt-fixture.ts";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const hermes = workflow.split("\n  hermes:\n")[1]!;
const rust = workflow.split("\n  rust:\n")[1]!.split("\n  package:\n")[0]!;

for (const path of [
  "hermes/build.sh", "hermes/hermes-wasi.patch", "crates/bunwasm-hermes/cpp/shim.cpp", "crates/bunwasm-engine-hermes/src/vm.rs",
  "tests/hermes/hosts/module.mts", "scripts/build-engine-hermes.sh", "scripts/build-bun-hermes.sh",
  "crates/bunwasm-engine-quickjs/src/driver.rs", "crates/bunwasm-engine-quickjs/src/side_modules.rs", "crates/bunwasm-runtime/src/engine.rs",
  "crates/bunwasm-host/src/linked.rs", "scripts/quickjs-core-exports.txt", "scripts/src/engine-explicit-init.ts", "src/engine-kind.ts",
  "scripts/guest-engine-receipt.ts", "src/bun-adapter.ts", "web/scripts/node-linked.ts", "web/build.ts", "web/src/engine-loader.ts",
  "scripts/hermes-hosts.ts", "scripts/hermes-ci.test.ts", "scripts/waffle-release-inputs.json",
]) test(`Hermes input ${path} retains the existing native producer and opts into Hermes`, () => {
  expect(needsHermes([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});

for (const path of ["docs/hermes-engine.md", "site/src/main.ts", "web/src/main.ts", "src/index.ts", "crates/bunwasm-engine-quickjs/src/vm.rs", "crates/bunwasm-engine-jsc/src/vm.rs", "jsc/webkit-wasi.patch", "crates/bunwasm-runtime/src/js/runtime.d.ts"]) {
  test(`unrelated input ${path} skips Hermes`, () => expect(needsHermes([path])).toBe(false));
}

test("one blocking Hermes job consumes the existing core and sysroot without compiling them", () => {
  expect(hermes).toContain("needs: [quality, rust]");
  expect(hermes).toContain("if: needs.quality.outputs.hermes == 'true'");
  expect(hermes).not.toMatch(/continue-on-error|build-bun-core\.sh|build-bun-hermes\.sh|build-jsc\.sh/);
  expect(hermes).not.toMatch(/^ +bun scripts\/build-wasi-sysroot\.ts(?! --inputs)/m);
  expect(hermes).toContain("name: hermes-common-inputs");
  expect(rust).toContain('"$CARGO_TARGET_DIR/split-common/bun-core.wasm"');
  expect(rust).toContain("name: hermes-common-inputs");
  expect(workflow.match(/CARGO_BUILD_JOBS=2 bash scripts\/build-bun-core\.sh/g)).toHaveLength(1);
  expect(hermes).toContain('bash tests/hermes/run.sh "$RUNNER_TEMP/hermes-inputs/bun-wasm" dist/bun-hermes.wasm');
  expect(hermes).toContain('bun scripts/hermes-hosts.ts dist/bun-hermes.wasm');
  expect(hermes).toContain("--node-only");
  expect(workflow).toContain("shared: ${{ steps.changes.outputs.shared }}");
  expect(workflow).toContain("\n  shared-sysroot:\n");
});

test("Hermes custody archives the compiled Bun codegen and admits it before VM work", async () => {
  const producer = rust.indexOf("test -s vendor/bun/build/debug/codegen/build_options.rs");
  const archive = rust.indexOf('tar -C vendor/bun -czf "$RUNNER_TEMP/hermes-inputs/bun-codegen.tar.gz"');
  const restore = hermes.indexOf('tar -xzf "$RUNNER_TEMP/hermes-inputs/bun-codegen.tar.gz" -C vendor/bun');
  const admit = hermes.indexOf("name: Admit the completed common core before Hermes VM work");
  const vm = hermes.indexOf("name: Build or verify the pinned Hermes VM");
  const side = hermes.indexOf("name: Build only the Hermes side");
  expect(producer).toBeGreaterThan(-1);
  expect(archive).toBeGreaterThan(producer);
  expect(restore).toBeGreaterThan(-1);
  expect(admit).toBeGreaterThan(restore);
  expect(admit).toBeLessThan(vm);
  expect(vm).toBeLessThan(side);
  expect(hermes.match(/guest-core-receipt\.ts tag "\$RUNNER_TEMP\/hermes-inputs\/bun-core\.wasm" hermes dist\/bun-hermes\.wasm/g)).toHaveLength(1);

  await withReceiptFixture(async options => {
    const generated = join(options.repository, "vendor/bun/build/debug/codegen/build_options.rs");
    const archiveRoot = mkdtempSync(join(tmpdir(), "hermes-core-codegen-"));
    try {
      const archive = join(archiveRoot, "bun-codegen.tar.gz");
      const producerResult = spawnSync("tar", ["-C", join(options.repository, "vendor/bun"), "-czf", archive, "build/debug/codegen"], { encoding: "utf8" });
      expect(producerResult.status, producerResult.stderr).toBe(0);
      const origin = await captureProgramInputs(options, "core", { features: ["engine-split", "bun-transpiler", "bun-build"] });
      expect(JSON.stringify(origin.content)).toContain("build/debug/codegen/build_options.rs");
      const tagged = quickjsPair().core;
      const tagBytes = appendCustomSection(new Uint8Array(), ENGINE_SECTION, new TextEncoder().encode("quickjs")).byteLength;
      const core = tagged.subarray(0, tagged.length - tagBytes);
      const receipt = { schema: 1, inputs: origin, artifact: artifactIdentity(core) } satisfies ProgramBuildReceipt;
      writeFileSync(generated, "consumer regeneration\n");
      const changed = await captureProgramInputs(options, "core", { features: ["engine-split", "bun-transpiler", "bun-build"] });
      expect(() => verifyProgramReceipt(core, receipt, changed)).toThrow(/compatibility mismatch/);
      const restoreResult = spawnSync("tar", ["-xzf", archive, "-C", join(options.repository, "vendor/bun")], { encoding: "utf8" });
      expect(restoreResult.status, restoreResult.stderr).toBe(0);
      const restored = await captureProgramInputs(options, "core", { features: ["engine-split", "bun-transpiler", "bun-build"] });
      expect(verifyProgramReceipt(core, receipt, restored)).toEqual(receipt);
    } finally {
      rmSync(archiveRoot, { recursive: true, force: true });
    }
  });
});

test("Hermes VM and side caches follow the compiler, sysroot, library and shared driver inputs", () => {
  expect(hermes).toContain("steps.host-tools.outputs.hash");
  expect(hermes).toContain("steps.hermes-sysroot-inputs.outputs.hash");
  expect(hermes).toContain("'hermes/**', 'crates/bunwasm-hermes/**'");
  expect(hermes).toContain("'Cargo.*', '.cargo/**', 'rust-toolchain.toml', 'hermes/**', 'crates/**'");
  expect(hermes).toContain('node hermes/check-build.ts "$HERMES_BUILD_DIR"');
  expect(hermes).toContain('path: ${{ env.HERMES_ENGINE_BUILD_DIR }}/target');
  expect(hermes).toContain('tar -xzf "$RUNNER_TEMP/hermes-inputs/cargo-sources.tar.gz"');
});

function cacheSaveConditions(): Array<{ name: string; condition: string }> {
  const parsed: unknown = Bun.YAML.parse(workflow);
  if (!parsed || typeof parsed !== "object" || !("jobs" in parsed)) throw Error("Missing workflow jobs");
  const jobs = parsed.jobs;
  if (!jobs || typeof jobs !== "object" || !("hermes" in jobs)) throw Error("Missing Hermes job");
  const job = jobs.hermes;
  if (!job || typeof job !== "object" || !("steps" in job) || !Array.isArray(job.steps)) throw Error("Missing Hermes steps");
  return job.steps.flatMap((step: unknown) => {
    if (!step || typeof step !== "object" || !("name" in step) || !("uses" in step) || step.uses !== "actions/cache/save@v4") return [];
    if (typeof step.name !== "string" || !("if" in step) || typeof step.if !== "string") throw Error("Invalid Hermes cache save");
    return [{ name: step.name, condition: step.if }];
  });
}

function allowSave(condition: string, state: { event: string; ref: string; hit: string; success: boolean; cancelled: boolean }): boolean {
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/success\(\)/g, String(state.success)).replace(/cancelled\(\)/g, String(state.cancelled))
    .replace(/github\.event_name/g, JSON.stringify(state.event)).replace(/github\.ref/g, JSON.stringify(state.ref))
    .replace(/steps\.[\w-]+\.outputs\.cache-hit/g, JSON.stringify(state.hit));
  const result: unknown = new Function(`return (${expression})`)();
  if (typeof result !== "boolean") throw Error("Cache save condition is not boolean");
  return result;
}

test("Hermes VM and side saves are explicit successful main-push misses", () => {
  const saves = cacheSaveConditions();
  expect(saves.map(save => save.name)).toEqual(["Save Hermes VM cache", "Save Hermes side cache"]);
  expect(hermes).not.toMatch(/^ +uses: actions\/cache@v4$/m);
  const main = { event: "push", ref: "refs/heads/main", hit: "false", success: true, cancelled: false };
  const cases = [
    [main, true], [{ ...main, hit: "" }, true], [{ ...main, hit: "true" }, false],
    [{ ...main, event: "pull_request", ref: "refs/pull/374/merge" }, false],
    [{ ...main, event: "pull_request", ref: "refs/pull/374/merge", hit: "" }, false],
    [{ ...main, ref: "refs/heads/feature" }, false], [{ ...main, cancelled: true }, false], [{ ...main, success: false }, false],
  ] as const;
  for (const save of saves) for (const [state, expected] of cases) expect(allowSave(save.condition, state), `${save.name} ${state.event} ${state.ref} ${state.hit}`).toBe(expected);
});

test("workflow shell steps parse without execution", () => {
  const parsed: unknown = Bun.YAML.parse(workflow);
  if (!parsed || typeof parsed !== "object" || !("jobs" in parsed) || !parsed.jobs || typeof parsed.jobs !== "object" || !("hermes" in parsed.jobs)) throw Error("Missing Hermes job");
  const job = parsed.jobs.hermes;
  if (!job || typeof job !== "object" || !("steps" in job) || !Array.isArray(job.steps)) throw Error("Missing Hermes steps");
  const scratch = mkdtempSync(join(tmpdir(), "hermes-ci-"));
  try {
    for (const [index, step] of job.steps.entries()) {
      if (typeof step.run !== "string") continue;
      const file = join(scratch, `${index}.sh`);
      writeFileSync(file, step.run);
      const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("Hermes CI contracts have one quality owner", () => {
  expect(discoverChecks().filter(check => check.path === "scripts/hermes-ci.test.ts").map(check => check.owner)).toEqual(["quality"]);
});
