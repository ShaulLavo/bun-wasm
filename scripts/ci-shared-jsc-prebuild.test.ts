import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";
import { expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedJscArtifact } from "./fixtures/jsc-artifact";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const workflow = expandedCiWorkflow();

function job(id: string): string {
  const body = workflow.split(`\n  ${id}:\n`)[1];
  if (!body) throw new Error(`Missing job ${id}`);
  return body.split(/\n  [\w-]+:\n/)[0]!;
}

test("shared C++ production starts independently of Rust inside the single bounded shared-sysroot producer", () => {
  const producer = job("shared-sysroot");
  expect(producer).toContain("needs: selection");
  expect(producer).not.toContain("needs.rust");
  expect(producer).toContain("timeout-minutes: 55");
  expect(producer).toContain("JSC_PROFILE=shared-group bash scripts/build-jsc.sh");
  expect(producer).toContain("id: shared-sysroot-cache");
  expect(producer).toContain("id: shared-jsc-cache");
  expect(workflow.match(/JSC_PROFILE=shared-group bash scripts\/build-jsc.sh/g)).toHaveLength(1);
});

function steps(id: string): Record<string, unknown>[] {
  const parsed: unknown = Bun.YAML.parse(job(id));
  assert(parsed && typeof parsed === "object" && "steps" in parsed && Array.isArray(parsed.steps));
  return parsed.steps.map((value: unknown) => {
    assert(value && typeof value === "object" && !Array.isArray(value));
    return Object.fromEntries(Object.entries(value));
  });
}

function command(id: string, name: string): string {
  const found = steps(id).find(item => item.name === name);
  assert(found && typeof found.run === "string", name);
  return found.run;
}

const buildName = "Build or verify the shared JSC prebuild";

test("the producer keeps the exact cache identity and validates warm bytes before saving", () => {
  const producer = steps("shared-sysroot");
  const cache = producer.find(item => item.id === "shared-jsc-cache");
  expect(cache?.with).toEqual({
    path: "${{ runner.temp }}/jsc/shared",
    key: "shared-jsc-prebuild-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.shared-jsc-inputs.outputs.hash }}",
  });
  const verify = producer.findIndex(item => item.name === buildName);
  const save = producer.findIndex(item => item.name === "Save the shared JSC prebuild");
  expect(save).toBeGreaterThan(verify);
  expect(producer[save]?.if).toBe("${{ success() && !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.selection.outputs.shared-native == 'true' && steps.shared-jsc-prebuild.outputs.jsc-ready == 'true' && steps.shared-jsc-cache.outputs.cache-hit != 'true' }}");
  expect(command("shared-sysroot", buildName)).toContain("check_jsc_inputs_stamp");
  expect(producer.find(item => item.id === "shared-binaryen")?.with).toEqual({
    path: "${{ env.WASM_TOOLS }}/binaryen-version_133-x86_64-linux.tar.gz",
    key: "binaryen-133-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/ci-binaryen.ts') }}",
  });
});

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-shared-handoff-"));
  const repo = join(root, "repo");
  const temp = join(root, "temp");
  const prebuild = join(temp, "jsc/shared");
  const sysroot = join(temp, "bun-wasm-shared-sysroot");
  mkdirSync(join(repo, "jsc"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  mkdirSync(temp);
  copyFileSync(new URL("../env.sh", import.meta.url), join(repo, "env.sh"));
  writeFileSync(join(repo, "jsc/common.sh"), [
    "check_jsc_inputs_stamp() {",
    '  echo verify >> "$CALLS"',
    '  test "$(cat "$JSC_BUILD_DIR/inputs-stamp")" = "$EXPECTED_INPUTS"',
    '  (cd "$JSC_BUILD_DIR" && sha256sum --check --strict artifacts)',
    "}", "",
  ].join("\n"));
  writeFileSync(join(repo, "scripts/build-jsc.sh"), 'echo compile >> "$CALLS"\nprintf expected > "$JSC_BUILD_DIR/inputs-stamp"\n');
  const env = {
    ...process.env, HOME: root,
    RUNNER_TEMP: temp, WASM_TOOLS: join(temp, "wasm-tools"), TMPDIR: temp,
    BUN_WASM_SHARED_SYSROOT: sysroot, BUN_WASM_SYSROOT: sysroot, JSC_BUILD_DIR: prebuild,
    GITHUB_OUTPUT: join(root, "outputs"),
    JSC_PROFILE: "shared-group", JOBS: "4", CAGE: "",
    EXPECTED_INPUTS: "expected", CALLS: join(root, "calls"),
  };
  return { root, repo, temp, prebuild, sysroot, env };
}

function seed(h: Fixture) {
  mkdirSync(join(h.sysroot, "lib/wasm32-wasip1"), { recursive: true });
  writeFileSync(join(h.sysroot, "lib/wasm32-wasip1/libc.a"), "libc");
  writeFileSync(join(h.sysroot, "bun-wasm-sysroot.json"), "expected-sysroot");
  mkdirSync(h.prebuild, { recursive: true });
  seedJscArtifact(h.prebuild, true);
  writeFileSync(join(h.prebuild, "libJavaScriptCore.a"), "archive\0bytes", { mode: 0o640 });
  writeFileSync(join(h.prebuild, "inputs-stamp"), "expected");
  symlinkSync("libJavaScriptCore.a", join(h.prebuild, "archive-link"));
  utimesSync(join(h.prebuild, "libJavaScriptCore.a"), 1_700_000_000, 1_700_000_000);
  const digest = new Bun.CryptoHasher("sha256").update("archive\0bytes").digest("hex");
  writeFileSync(join(h.prebuild, "artifacts"), `${digest}  libJavaScriptCore.a\n`);
}

function bash(h: Fixture, script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
    cwd: h.repo, env: { ...h.env, ...env }, encoding: "utf8", timeout: 10_000,
  });
}

function withFixture(body: (h: Fixture) => void) {
  const h = fixture();
  try { body(h); }
  finally { rmSync(h.root, { recursive: true, force: true }); }
}

for (const hit of ["false", "true"]) {
  test(`cache hit=${hit} runs the producer verifier and compiles only on a miss`, () => withFixture(h => {
    seed(h);
    if (hit === "false") rmSync(join(h.prebuild, "inputs-stamp"));
    const result = bash(h, command("shared-sysroot", buildName), { CI_SHARED_JSC_HIT: hit });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(h.env.CALLS, "utf8")).toBe(hit === "true" ? "verify\n" : "compile\nverify\n");
    expect(readFileSync(h.env.GITHUB_OUTPUT, "utf8")).toBe("jsc-ready=true\n");
  }));
}

for (const file of ["inputs-stamp", "libJavaScriptCore.a"]) {
  test(`an exact cache hit with stale ${file} fails verification without a hidden rebuild`, () => withFixture(h => {
    seed(h);
    writeFileSync(join(h.prebuild, file), "stale");
    expect(bash(h, command("shared-sysroot", buildName), { CI_SHARED_JSC_HIT: "true" }).status).not.toBe(0);
    expect(readFileSync(h.env.CALLS, "utf8")).toBe("verify\n");
  }));
}

type GraphState = { selection: string; shared: boolean; sharedNative: boolean; cancelled: boolean };

function admitted(id: string, state: GraphState): boolean {
  const parsed: unknown = Bun.YAML.parse(job(id));
  assert(parsed && typeof parsed === "object" && "if" in parsed && typeof parsed.if === "string");
  const condition = parsed.if;
  const implicit = !state.cancelled && state.selection === "success";
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("github.event_name", '"pull_request"')
    .replaceAll("github.event.pull_request.draft", "false")
    .replaceAll("needs.selection.outputs.shared-native", JSON.stringify(String(state.sharedNative)))
    .replaceAll("needs.selection.outputs.shared", JSON.stringify(String(state.shared)));
  const result: unknown = new Function(`return (${expression})`)();
  assert(typeof result === "boolean");
  return implicit && result;
}

test("shared-sysroot runs independently of Rust whenever shared or shared-native is selected", () => {
  const base = { selection: "success", cancelled: false };
  for (const [shared, sharedNative] of [[false, false], [true, false], [false, true], [true, true]] satisfies [boolean, boolean][]) {
    expect(admitted("shared-sysroot", { ...base, shared, sharedNative })).toBe(shared || sharedNative);
  }
  expect(admitted("shared-sysroot", { ...base, shared: true, sharedNative: false, selection: "failure" })).toBe(false);
  expect(admitted("shared-sysroot", { ...base, shared: true, sharedNative: false, cancelled: true })).toBe(false);
});
