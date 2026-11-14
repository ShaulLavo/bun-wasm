import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

function document(path: string): RecordValue {
  return record(Bun.YAML.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")));
}

function steps(value: RecordValue): RecordValue[] {
  if (!Array.isArray(value.steps)) throw new Error("Expected steps");
  return value.steps.map(record);
}

function step(value: RecordValue, key: string, name: string): RecordValue {
  const selected = steps(value).filter(item => item[key] === name);
  expect(selected).toHaveLength(1);
  return selected[0]!;
}

function script(value: RecordValue): string {
  if (typeof value.run !== "string") throw new Error("Expected shell script");
  return value.run;
}

const ci = document(".github/workflows/ci.yml");
const warm = document(".github/workflows/jsc-prebuild.yml");
const setup = record(document(".github/actions/jsc-setup/action.yml").runs);
const build = record(document(".github/actions/jsc-prebuild/action.yml").runs);
const ciJobs = record(ci.jobs);
const warmJobs = record(warm.jobs);

test("main warms effective JSC generations outside the full push queue without claiming its protected check", () => {
  expect(warm.on).toEqual({ push: { branches: ["main"] } });
  expect(warm.concurrency).toBeUndefined();
  expect(warm.permissions).toEqual({ contents: "read" });
  expect(record(warmJobs.identity).needs).toBeUndefined();
  expect(record(warmJobs["jsc-prebuild"]).name).toBe("Warm verified JSC cache");
  expect(record(ciJobs["jsc-prebuild"]).name).toBe("JSC C/C++ prebuild");
  expect(record(ciJobs["jsc-identity"]).if).toBe(record(ciJobs["jsc-prebuild"]).if);
  expect(record(ciJobs["jsc-identity"]).needs).toBe("selection");
  expect(record(ciJobs["jsc-prebuild"]).needs).toEqual(["selection", "jsc-identity"]);
});

for (const [jobs, identity, transfer] of [[ciJobs, "jsc-identity", "true"], [warmJobs, "identity", "false"]] as const) {
  test(`${transfer === "true" ? "full CI" : "independent producer"} locks the same existing effective cache identity before restore`, () => {
    const producer = record(jobs["jsc-prebuild"]);
    expect(producer.concurrency).toEqual({ group: `\${{ needs.${identity}.outputs.key }}`, "cancel-in-progress": false, queue: "max" });
    expect(record(jobs[identity]).outputs).toEqual({ key: "${{ steps.setup.outputs.key }}", "sysroot-sha256": "${{ steps.sysroot.outputs.sha256 }}" });
    for (const job of [record(jobs[identity]), producer]) expect(step(job, "id", "setup").uses).toBe("./.github/actions/jsc-setup");
    expect(step(producer, "id", "setup").with).toEqual({ sysroot: `\${{ needs.${identity}.outputs.sysroot-sha256 }}` });
    expect(step(producer, "uses", "actions/download-artifact@v8").with).toEqual({ name: "jsc-identity-sysroot.tar.zst", path: "${{ runner.temp }}" });
    expect(step(producer, "id", "prebuild")).toMatchObject({
      uses: "./.github/actions/jsc-prebuild",
      with: { key: "${{ steps.setup.outputs.key }}", prefix: "${{ steps.setup.outputs.prefix }}", "expected-key": `\${{ needs.${identity}.outputs.key }}`, transfer },
    });
    expect(producer["timeout-minutes"]).toBe(45);
    expect(step(build, "id", "jsc-prebuild-cache").with).toEqual({ path: "${{ runner.temp }}/jsc/prebuild", key: "${{ inputs.key }}", "restore-keys": "${{ inputs.prefix }}\n" });
    expect(steps(build)[0]?.name).toBe("Require the identity used to serialize producers");
  });
}

test("the existing key, compatible prefix and run-bound handoff stay intact", () => {
  const identity = record(step(setup, "id", "identity").env);
  const prefix = "jsc-prebuild-v2-${{ runner.os }}-${{ runner.arch }}-${{ steps.host-tools.outputs.hash }}-${{ steps.jsc-inputs.outputs.hash }}-";
  expect(identity.CACHE_PREFIX).toBe(prefix);
  expect(identity.CACHE_KEY).toBe(prefix + "${{ hashFiles('scripts/build-wasi-sysroot.ts') }}");
  expect(step(build, "id", "jsc-artifact").if).toBe("inputs.transfer == 'true'");
  const upload = step(record(ciJobs["jsc-prebuild"]), "uses", "actions/upload-artifact@v7");
  expect(upload["timeout-minutes"]).toBe(5);
  expect(record(upload.with).path).toBe("${{ runner.temp }}/jsc-prebuild.tar");
  expect(script(step(build, "id", "jsc-artifact"))).toContain('"$GITHUB_RUN_ID" "$GITHUB_SHA" "$JSC_BUILD_DIR" "$BUN_WASM_SYSROOT"');
  const save = step(build, "name", "Save the JSC prebuild cache once per input revision");
  expect(save.if).toBe("${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.jsc-producer.outputs.jsc-ready == 'true' && steps.jsc-prebuild-cache.outputs.cache-hit != 'true' }}");
});

test("JSC composite steps use runner-supported metadata", () => {
  const names = ["jsc-setup", "jsc-prebuild", "shared-jsc-setup", "shared-jsc-prebuild"];
  const compositeSteps = names.flatMap(name => steps(record(document(`.github/actions/${name}/action.yml`).runs)));
  for (const item of compositeSteps) {
    expect(item).not.toHaveProperty("timeout-minutes");
    if (item.run === undefined) continue;
    expect(item.shell).toBeString();
    expect(item.shell).not.toBe("");
  }
});

test.each(["", "different-runner-inputs"])("identity guard rejects %j before restoring or building", actual => {
  const guard = script(steps(build)[0]!);
  const result = spawnSync("bash", ["-e", "-c", guard], { env: { ...process.env, EXPECTED_KEY: "effective-inputs", ACTUAL_KEY: actual } });
  expect(result.status).not.toBe(0);
});

function withFixture(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-cache-"));
  try { body(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function preparedSysroot(root: string) {
  const tools = join(root, "tools");
  const sysroot = join(tools, "bun-wasm-sysroot-patched");
  mkdirSync(join(sysroot, "lib"), { recursive: true });
  writeFileSync(join(sysroot, "lib/libc.a"), "verified libc");
  symlinkSync("lib/libc.a", join(sysroot, "alias"));
  writeFileSync(join(root, "env.sh"), "set -euo pipefail\n");
  const output = join(root, "output");
  const env = { ...process.env, RUNNER_TEMP: root, WASM_TOOLS: tools, BUN_WASM_SYSROOT: sysroot, GITHUB_OUTPUT: output };
  const packaged = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(step(record(ciJobs["jsc-identity"]), "id", "sysroot"))], { cwd: root, env, encoding: "utf8" });
  expect(packaged.status, packaged.stderr).toBe(0);
  const digest = readFileSync(output, "utf8").trim().slice("sha256=".length);
  rmSync(sysroot, { recursive: true });
  const consume = (sha256 = digest) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(step(setup, "name", "Import this run's prepared sysroot"))], {
    cwd: root, env: { ...env, SYSROOT_SHA256: sha256 }, encoding: "utf8",
  });
  return { sysroot, consume };
}

test("the prepared sysroot transfers once with its bytes and symlinks intact", () => withFixture(root => {
  const { sysroot, consume } = preparedSysroot(root);
  const result = consume();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(sysroot, "lib/libc.a"), "utf8")).toBe("verified libc");
  expect(readlinkSync(join(sysroot, "alias"))).toBe("lib/libc.a");
  expect(existsSync(join(root, "jsc-identity-sysroot.tar.zst"))).toBe(false);
  expect(step(setup, "id", "sysroot-cache").if).toBe("inputs.sysroot == 'build'");
  const names = steps(setup).map(item => item.name);
  expect(names.indexOf("Build patched WASI sysroot")).toBeGreaterThan(names.indexOf("Import this run's prepared sysroot"));
}));

test.each(["missing digest", "wrong digest", "changed bytes", "existing output"])("the sysroot transfer rejects %s before extraction", problem => withFixture(root => {
  const { sysroot, consume } = preparedSysroot(root);
  if (problem === "changed bytes") writeFileSync(join(root, "jsc-identity-sysroot.tar.zst"), "changed bytes");
  if (problem === "existing output") symlinkSync("missing-owner-data", sysroot);
  const digest = problem === "missing digest" ? "" : problem === "wrong digest" ? "0".repeat(64) : undefined;
  const result = consume(digest);
  expect(result.status).not.toBe(0);
  expect(existsSync(join(sysroot, "lib/libc.a"))).toBe(false);
  if (problem === "existing output") expect(readlinkSync(sysroot)).toBe("missing-owner-data");
}));

function runProducer(root: string, name: string, hit: boolean, expected = "effective-inputs") {
  const cwd = join(root, name);
  const prebuild = join(cwd, "prebuild");
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  mkdirSync(join(cwd, "jsc"));
  mkdirSync(prebuild);
  writeFileSync(join(cwd, "env.sh"), "set -euo pipefail\n");
  writeFileSync(join(cwd, "scripts/build-jsc.sh"), 'echo build >> "$BUILDS"\nprintf effective-inputs > "$JSC_BUILD_DIR/stamp"\n');
  writeFileSync(join(cwd, "jsc/common.sh"), 'check_jsc_inputs_stamp() { echo verify >> "$VERIFICATIONS"; [[ "$(cat "$JSC_BUILD_DIR/stamp")" == "$EXPECTED_INPUTS" ]]; }\n');
  if (hit) cpSync(join(root, "cached-stamp"), join(prebuild, "stamp"));
  const output = join(cwd, "output");
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(step(build, "id", "jsc-producer"))], {
    cwd, encoding: "utf8", timeout: 5000,
    env: { ...process.env, RUNNER_TEMP: cwd, GITHUB_OUTPUT: output, JSC_BUILD_DIR: prebuild, CI_JSC_PREBUILD_HIT: String(hit),
      BUILDS: join(root, "builds"), VERIFICATIONS: join(root, "verifications"), EXPECTED_INPUTS: expected },
  });
  return { result, output, prebuild };
}

test("a main cache miss builds once and subsequent full main and PR consumers only verify", () => withFixture(root => {
  const cold = runProducer(root, "independent-main", false);
  expect(cold.result.status, cold.result.stderr).toBe(0);
  expect(readFileSync(cold.output, "utf8")).toBe("jsc-ready=true\n");
  cpSync(join(cold.prebuild, "stamp"), join(root, "cached-stamp"));
  for (const name of ["full-main", "pull-request", "next-main-same-effective-inputs"]) {
    const warm = runProducer(root, name, true);
    expect(warm.result.status, warm.result.stderr).toBe(0);
    expect(readFileSync(warm.output, "utf8")).toBe("jsc-ready=true\n");
  }
  expect(readFileSync(join(root, "builds"), "utf8")).toBe("build\n");
  expect(readFileSync(join(root, "verifications"), "utf8")).toBe("verify\n".repeat(4));
}));

test("an unavailable prebuild keeps the cold fallback, while a mismatched restored stamp fails closed", () => withFixture(root => {
  const cold = runProducer(root, "fallback", false);
  expect(cold.result.status, cold.result.stderr).toBe(0);
  cpSync(join(cold.prebuild, "stamp"), join(root, "cached-stamp"));
  const bad = runProducer(root, "mismatched-cache", true, "changed-inputs");
  expect(bad.result.status).not.toBe(0);
  expect(existsSync(bad.output)).toBe(false);
  expect(readFileSync(join(root, "builds"), "utf8")).toBe("build\n");
}));
