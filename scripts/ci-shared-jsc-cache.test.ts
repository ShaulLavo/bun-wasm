import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsSharedNative, needsSharedSysroot } from "./ci-changes";
import { discoverChecks } from "./test-checks";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected YAML object");
  return Object.fromEntries(Object.entries(value));
}

function document(path: string): Record<string, unknown> {
  return record(Bun.YAML.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")));
}

function steps(value: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(value.steps)) throw new Error("Expected steps");
  return value.steps.map(record);
}

function step(value: Record<string, unknown>, key: string, name: string): Record<string, unknown> {
  const found = steps(value).filter(item => item[key] === name);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function script(value: Record<string, unknown>): string {
  if (typeof value.run !== "string") throw new Error("Expected shell script");
  return value.run;
}

const ci = document(".github/workflows/ci.yml");
const warm = document(".github/workflows/jsc-prebuild.yml");
const setup = record(document(".github/actions/shared-jsc-setup/action.yml").runs);
const build = record(document(".github/actions/shared-jsc-prebuild/action.yml").runs);
const ciJobs = record(ci.jobs);
const warmJobs = record(warm.jobs);

test("shared warming bypasses full CI admission and keeps main-only publication and existing protected names", () => {
  expect(warm.on).toEqual({ push: { branches: ["main"] } });
  expect(warm.concurrency).toBeUndefined();
  expect(warm.permissions).toEqual({ contents: "read" });
  expect(record(warmJobs["shared-identity"]).needs).toBeUndefined();
  expect(record(warmJobs["shared-prebuild"]).name).toBe("Warm verified shared JSC cache");
  expect(record(ciJobs["shared-prebuild"]).name).toBe("Shared PIC sysroot and JSC prebuild");
  expect(record(ciJobs["shared-jsc-identity"]).if).toBe(record(ciJobs["shared-prebuild"]).if);
  expect(record(ciJobs["shared-jsc-identity"]).needs).toBe("selection");
  expect(record(ciJobs["shared-prebuild"]).needs).toEqual(["selection", "shared-jsc-identity"]);
  expect(record(warm.env).CI_NODE_VERSION).toBe(record(ci.env).CI_NODE_VERSION);
  expect(discoverChecks().filter(check => check.path === "scripts/ci-shared-jsc-cache.test.ts").map(check => check.owner)).toEqual(["quality"]);
});

for (const [label, jobs, identity] of [["full CI", ciJobs, "shared-jsc-identity"], ["early warmer", warmJobs, "shared-identity"]] as const) {
  test(`${label} resolves and rechecks the same effective identity under the shared lock`, () => {
    const producer = record(jobs["shared-prebuild"]);
    expect(producer.concurrency).toEqual({ group: `\${{ needs.${identity}.outputs.key }}`, "cancel-in-progress": false, queue: "max" });
    expect(producer["timeout-minutes"]).toBe(45);
    expect(record(jobs[identity]).outputs).toEqual({ key: "${{ steps.setup.outputs.key }}", "sysroot-sha256": "${{ steps.sysroot.outputs.sha256 }}" });
    for (const job of [record(jobs[identity]), producer]) {
      expect(step(job, "id", "setup").uses).toBe("./.github/actions/shared-jsc-setup");
      expect(record(job.env).WASI_LIBC_JOBS).toBe("2");
    }
    expect(record(step(producer, "id", "setup").with).sysroot).toBe(`\${{ needs.${identity}.outputs.sysroot-sha256 }}`);
    expect(step(producer, "uses", "actions/download-artifact@v8").with).toEqual({ name: "shared-jsc-identity-sysroot.tar.zst", path: "${{ runner.temp }}" });
    expect(step(producer, "uses", "./.github/actions/shared-jsc-prebuild").with).toEqual({ key: "${{ steps.setup.outputs.key }}", "expected-key": `\${{ needs.${identity}.outputs.key }}` });
    expect(steps(build)[0]?.name).toBe("Require the identity used to serialize shared producers");
  });
}

test("the existing exact JSC key follows effective inputs and preserves sysroot-only selection", () => {
  expect(record(step(setup, "id", "identity").env).JSC_KEY).toBe("shared-jsc-prebuild-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.shared-jsc-inputs.outputs.hash }}");
  expect(step(build, "id", "shared-jsc-cache").with).toEqual({ path: "${{ runner.temp }}/jsc/shared", key: "${{ inputs.key }}" });
  expect(step(setup, "id", "shared-jsc-inputs").env).toEqual({ JSC_PROFILE: "shared-group", JOBS: "2", CAGE: "" });
  expect(script(step(setup, "id", "shared-jsc-inputs"))).toContain("inputs=$(jsc_inputs_hash)");
  expect(step(setup, "id", "shared-jsc-inputs").if).toBe("inputs.shared-native == 'true'");
  expect(step(record(ciJobs["shared-prebuild"]), "uses", "./.github/actions/shared-jsc-prebuild").if).toBe("needs.selection.outputs.shared-native == 'true'");
  for (const path of [".github/actions/shared-jsc-setup/action.yml", ".github/actions/shared-jsc-prebuild/action.yml"]) {
    expect(needsSharedNative([path])).toBe(true);
    expect(needsSharedSysroot([path])).toBe(true);
  }
});

test.each(["", "another-input-key"])("the lock guard rejects %j before cache restore", actual => {
  expect(spawnSync("bash", ["-e", "-c", script(steps(build)[0]!)], {
    env: { ...process.env, EXPECTED_KEY: "locked-key", ACTUAL_KEY: actual },
  }).status).not.toBe(0);
});

function withFixture(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-shared-cache-"));
  try { body(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("sysroot-only work locks its existing sysroot generation without requiring JSC", () => withFixture(root => {
  const output = join(root, "output");
  const command = script(step(setup, "id", "identity"));
  for (const native of ["true", "false"]) {
    expect(spawnSync("bash", ["-e", "-c", command], { env: { ...process.env, GITHUB_OUTPUT: output,
      SHARED_NATIVE: native, JSC_KEY: "jsc-generation", SYSROOT_KEY: "sysroot-generation" } }).status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`key=${native === "true" ? "jsc" : "sysroot"}-generation\n`);
    rmSync(output);
  }
}));

function preparedSysroot(root: string) {
  const sysroot = join(root, "bun-wasm-shared-sysroot");
  mkdirSync(join(sysroot, "lib"), { recursive: true });
  writeFileSync(join(sysroot, "lib/libc.a"), "verified shared libc");
  symlinkSync("lib/libc.a", join(sysroot, "alias"));
  writeFileSync(join(root, "env.sh"), "set -euo pipefail\n");
  const output = join(root, "output");
  const env = { ...process.env, RUNNER_TEMP: root, BUN_WASM_SYSROOT: sysroot, GITHUB_OUTPUT: output };
  const packaged = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(step(record(ciJobs["shared-jsc-identity"]), "id", "sysroot"))], { cwd: root, env, encoding: "utf8" });
  expect(packaged.status, packaged.stderr).toBe(0);
  const digest = readFileSync(output, "utf8").trim().slice("sha256=".length);
  rmSync(sysroot, { recursive: true });
  const consume = (sha256 = digest) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(step(setup, "name", "Import this run's prepared shared sysroot"))], {
    cwd: root, env: { ...env, SYSROOT_SHA256: sha256 }, encoding: "utf8",
  });
  return { sysroot, consume };
}

test("identity hands the verified sysroot to the locked job without rebuilding or losing symlinks", () => withFixture(root => {
  const { sysroot, consume } = preparedSysroot(root);
  const imported = consume();
  expect(imported.status, imported.stderr).toBe(0);
  expect(readFileSync(join(sysroot, "lib/libc.a"), "utf8")).toBe("verified shared libc");
  expect(readlinkSync(join(sysroot, "alias"))).toBe("lib/libc.a");
  expect(existsSync(join(root, "shared-jsc-identity-sysroot.tar.zst"))).toBe(false);
  expect(step(setup, "id", "shared-sysroot-cache").if).toBe("inputs.sysroot == 'build'");
  const names = steps(setup).map(item => item.name);
  expect(names.indexOf("Build or verify shared profile")).toBeGreaterThan(names.indexOf("Import this run's prepared shared sysroot"));
}));

test.each(["missing digest", "wrong digest", "changed bytes", "existing output"])("sysroot handoff rejects %s before extraction", problem => withFixture(root => {
  const { sysroot, consume } = preparedSysroot(root);
  if (problem === "changed bytes") writeFileSync(join(root, "shared-jsc-identity-sysroot.tar.zst"), "changed bytes");
  if (problem === "existing output") symlinkSync("owner-data", sysroot);
  const digest = problem === "missing digest" ? "" : problem === "wrong digest" ? "0".repeat(64) : undefined;
  expect(consume(digest).status).not.toBe(0);
  expect(existsSync(join(sysroot, "lib/libc.a"))).toBe(false);
  if (problem === "existing output") expect(readlinkSync(sysroot)).toBe("owner-data");
}));
