import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsHermes, needsRust } from "./ci-changes.ts";
import { discoverChecks } from "./test-checks.ts";

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

test("Hermes VM and side caches follow the compiler, sysroot, library and shared driver inputs", () => {
  expect(hermes).toContain("steps.host-tools.outputs.hash");
  expect(hermes).toContain("steps.hermes-sysroot-inputs.outputs.hash");
  expect(hermes).toContain("'hermes/**', 'crates/bunwasm-hermes/**'");
  expect(hermes).toContain("'Cargo.*', '.cargo/**', 'rust-toolchain.toml', 'hermes/**', 'crates/**'");
  expect(hermes).toContain('node hermes/check-build.ts "$HERMES_BUILD_DIR"');
  expect(hermes).toContain('path: ${{ env.HERMES_ENGINE_BUILD_DIR }}/target');
  expect(hermes).toContain('tar -xzf "$RUNNER_TEMP/hermes-inputs/cargo-sources.tar.gz"');
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
