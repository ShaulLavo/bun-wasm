import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function job(id: string): string {
  const body = workflow.split(`\n  ${id}:\n`)[1];
  if (!body) throw new Error(`Missing job ${id}`);
  return body.split(/\n  [\w-]+:\n/)[0]!;
}

test("shared C++ production starts independently of Rust and has one owner outside the bounded consumer", () => {
  const producer = job("shared-prebuild");
  const consumer = job("shared-sysroot");
  expect(producer).toContain("needs: quality");
  expect(producer).not.toContain("needs.rust");
  expect(producer).toContain("timeout-minutes: 45");
  expect(consumer).toContain("needs: [quality, rust, shared-prebuild]");
  expect(consumer).toContain("timeout-minutes: 30");
  expect(producer).toContain("JSC_PROFILE=shared-group bash scripts/build-jsc.sh");
  expect(consumer).not.toContain("bash scripts/build-jsc.sh");
  expect(consumer).not.toContain("id: shared-sysroot-cache");
  expect(consumer).not.toContain("id: shared-jsc-cache");
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
const packageName = "Package the verified shared prebuild and sysroot";
const importName = "Import the verified shared prebuild and sysroot";

test("the producer keeps the old exact cache identity and validates warm bytes before saving", () => {
  const producer = steps("shared-prebuild");
  const cache = producer.find(item => item.id === "shared-jsc-cache");
  expect(cache?.with).toEqual({
    path: "${{ runner.temp }}/jsc/shared",
    key: "shared-jsc-prebuild-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.shared-jsc-inputs.outputs.hash }}",
  });
  const verify = producer.findIndex(item => item.name === buildName);
  const save = producer.findIndex(item => item.name === "Save the shared JSC prebuild");
  expect(save).toBeGreaterThan(verify);
  expect(producer.findIndex(item => item.name === packageName)).toBeGreaterThan(save);
  expect(producer[save]?.if).toBe("${{ success() && !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.quality.outputs.shared-native == 'true' && steps.shared-jsc-cache.outputs.cache-hit != 'true' }}");
  expect(command("shared-prebuild", buildName)).toContain("check_jsc_inputs_stamp");
  expect(job("shared-prebuild")).not.toMatch(/test-checks|test-shared-sysroot|build-native-profile|rust-toolchain/);
});

type Fixture = ReturnType<typeof fixture>;

function fixture(sharedNative: "true" | "false") {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-shared-handoff-"));
  const repo = join(root, "repo");
  const temp = join(root, "temp");
  const prebuild = join(temp, "jsc/shared");
  const sysroot = join(temp, "bun-wasm-shared-sysroot");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "jsc"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  mkdirSync(bin);
  mkdirSync(temp);
  copyFileSync(new URL("../env.sh", import.meta.url), join(repo, "env.sh"));
  // Only expensive build/input verification is substituted. Transport runs the workflow's real shell.
  writeFileSync(join(repo, "jsc/common.sh"), [
    'check_jsc_inputs_stamp() {',
    '  echo verify >> "$CALLS"',
    '  test "$(cat "$JSC_BUILD_DIR/inputs-stamp")" = "$EXPECTED_INPUTS"',
    '  (cd "$JSC_BUILD_DIR" && sha256sum --check --strict artifacts)',
    '}', "",
  ].join("\n"));
  writeFileSync(join(repo, "scripts/build-jsc.sh"), 'echo compile >> "$CALLS"\nprintf expected > "$JSC_BUILD_DIR/inputs-stamp"\n');
  writeFileSync(join(bin, "bun"), '#!/bin/bash\nset -euo pipefail\ntest "$*" = "scripts/build-wasi-sysroot.ts --shared-pic"\necho sysroot-verify >> "$CALLS"\ntest "$(cat "$BUN_WASM_SYSROOT/bun-wasm-sysroot.json")" = "$EXPECTED_SYSROOT"\n', { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
    RUNNER_TEMP: temp, WASM_TOOLS: join(temp, "wasm-tools"), TMPDIR: temp,
    BUN_WASM_SHARED_SYSROOT: sysroot, BUN_WASM_SYSROOT: sysroot, JSC_BUILD_DIR: prebuild,
    GITHUB_RUN_ID: "4200", GITHUB_SHA: "a".repeat(40), GITHUB_OUTPUT: join(root, "outputs"),
    SHARED_NATIVE: sharedNative, JSC_PROFILE: "shared-group", JOBS: "2", CAGE: "",
    EXPECTED_INPUTS: "expected", EXPECTED_SYSROOT: "expected-sysroot", CALLS: join(root, "calls"),
  };
  return { root, repo, temp, prebuild, sysroot, env };
}

function seed(h: Fixture) {
  mkdirSync(join(h.sysroot, "lib/wasm32-wasip1"), { recursive: true });
  writeFileSync(join(h.sysroot, "lib/wasm32-wasip1/libc.a"), "libc");
  writeFileSync(join(h.sysroot, "bun-wasm-sysroot.json"), "expected-sysroot");
  mkdirSync(join(h.sysroot, "include"));
  symlinkSync(h.env.WASM_TOOLS, join(h.sysroot, "include/absolute-sdk-link"));
  symlinkSync("../lib", join(h.sysroot, "include/sdk-link"));
  if (h.env.SHARED_NATIVE !== "true") return;
  mkdirSync(h.prebuild, { recursive: true });
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

function withFixture(sharedNative: "true" | "false", body: (h: Fixture) => void) {
  const h = fixture(sharedNative);
  try { body(h); }
  finally { rmSync(h.root, { recursive: true, force: true }); }
}

function pack(h: Fixture): string {
  const result = bash(h, command("shared-prebuild", packageName));
  expect(result.status, result.stderr).toBe(0);
  const digest = readFileSync(h.env.GITHUB_OUTPUT, "utf8").trim().split("=")[1];
  assert(digest);
  const transfer = join(h.temp, "shared-prebuild-transfer");
  mkdirSync(transfer);
  renameSync(join(h.temp, "shared-prebuild.tar"), join(transfer, "shared-prebuild.tar"));
  rmSync(join(h.temp, "shared-prebuild-artifact"), { recursive: true });
  rmSync(h.sysroot, { recursive: true });
  rmSync(h.prebuild, { recursive: true, force: true });
  return digest;
}

function consume(h: Fixture, digest: string, env: Record<string, string> = {}) {
  return bash(h, command("shared-sysroot", importName), { SHARED_PREBUILD_MANIFEST_SHA256: digest, ...env });
}

for (const hit of ["false", "true"]) {
  test(`cache hit=${hit} runs the producer verifier and compiles only on a miss`, () => withFixture("true", h => {
    seed(h);
    if (hit === "false") rmSync(join(h.prebuild, "inputs-stamp"));
    const result = bash(h, command("shared-prebuild", buildName), { CI_SHARED_JSC_HIT: hit });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(h.env.CALLS, "utf8")).toBe(hit === "true" ? "verify\n" : "compile\nverify\n");
  }));
}

for (const sharedNative of ["true", "false"] satisfies ("true" | "false")[]) {
  test(`same-run shared-native=${sharedNative} hand-off preserves bytes, symlinks and mtimes without compiling`, () => withFixture(sharedNative, h => {
    seed(h);
    const digest = pack(h);
    const result = consume(h, digest);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(h.sysroot, "lib/wasm32-wasip1/libc.a"), "utf8")).toBe("libc");
    expect(readlinkSync(join(h.sysroot, "include/sdk-link"))).toBe("../lib");
    expect(readlinkSync(join(h.sysroot, "include/absolute-sdk-link"))).toBe(h.env.WASM_TOOLS);
    expect(readFileSync(h.env.CALLS, "utf8")).toBe(sharedNative === "true" ? "sysroot-verify\nverify\n" : "sysroot-verify\n");
    if (sharedNative === "false") return;
    const archive = join(h.prebuild, "libJavaScriptCore.a");
    expect(readFileSync(archive).toString()).toBe("archive\0bytes");
    expect(lstatSync(archive).mode & 0o777).toBe(0o640);
    expect(lstatSync(archive).mtimeMs).toBe(1_700_000_000_000);
    expect(readlinkSync(join(h.prebuild, "archive-link"))).toBe("libJavaScriptCore.a");
  }));
}

for (const file of ["inputs-stamp", "libJavaScriptCore.a"]) {
  test(`an exact cache hit with stale ${file} fails verification without a hidden rebuild`, () => withFixture("true", h => {
    seed(h);
    writeFileSync(join(h.prebuild, file), "stale");
    expect(bash(h, command("shared-prebuild", buildName), { CI_SHARED_JSC_HIT: "true" }).status).not.toBe(0);
    expect(readFileSync(h.env.CALLS, "utf8")).toBe("verify\n");
  }));
}

const wrongSourceCases: Record<string, string>[] = [
  { GITHUB_RUN_ID: "other" }, { GITHUB_SHA: "b".repeat(40) }, { SHARED_NATIVE: "false" },
  { SHARED_PREBUILD_MANIFEST_SHA256: "" }, { SHARED_PREBUILD_MANIFEST_SHA256: "0".repeat(64) },
];
for (const env of wrongSourceCases) {
  test(`import rejects ${Object.keys(env)[0]} mismatch before extracting`, () => withFixture("true", h => {
    seed(h);
    const digest = pack(h);
    expect(consume(h, digest, env).status).not.toBe(0);
    expect(existsSync(h.sysroot)).toBe(false);
    expect(existsSync(h.prebuild)).toBe(false);
    expect(existsSync(h.env.CALLS)).toBe(false);
  }));
}

function alterTransfer(h: Fixture, mutate: (bundle: string) => void) {
  const bundle = join(h.root, "rewrite");
  mkdirSync(bundle);
  const archive = join(h.temp, "shared-prebuild-transfer/shared-prebuild.tar");
  execFileSync("tar", ["-xf", archive, "-C", bundle]);
  mutate(bundle);
  execFileSync("tar", ["--posix", "-C", bundle, "-cf", archive, "sysroot.tar.zst", "prebuild.tar.zst", "manifest"]);
}

for (const member of ["sysroot.tar.zst", "prebuild.tar.zst"]) {
  test(`import rejects corrupt ${member} bytes before extracting`, () => withFixture("true", h => {
    seed(h);
    const digest = pack(h);
    alterTransfer(h, bundle => writeFileSync(join(bundle, member), "corrupt"));
    expect(consume(h, digest).status).not.toBe(0);
    expect(existsSync(h.sysroot)).toBe(false);
    expect(existsSync(h.prebuild)).toBe(false);
  }));
}

test("import rejects a missing receipt instead of running a hidden sysroot build", () => withFixture("true", h => {
  seed(h);
  rmSync(join(h.sysroot, "bun-wasm-sysroot.json"));
  const digest = pack(h);
  expect(consume(h, digest).status).not.toBe(0);
  expect(existsSync(h.env.CALLS)).toBe(false);
}));

test("a failed prebuild keeps the selected consumer blocking", () => {
  const condition = steps("shared-sysroot");
  expect(job("shared-sysroot")).toContain("!cancelled() && needs.quality.result == 'success'");
  expect(condition[1]?.name).toBe("Require the shared prebuild producer");
  const guard = command("shared-sysroot", "Require the shared prebuild producer");
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    expect(spawnSync("bash", ["-euo", "pipefail", "-c", guard], { env: { ...process.env, SHARED_PREBUILD_RESULT: result } }).status).toBe(1);
  }
});

for (const field of ["EXPECTED_INPUTS", "EXPECTED_SYSROOT"]) {
  test(`consumer revalidates ${field} against its own environment`, () => withFixture("true", h => {
    seed(h);
    const digest = pack(h);
    expect(consume(h, digest, { [field]: "different" }).status).not.toBe(0);
    expect(readFileSync(h.env.CALLS, "utf8")).not.toContain("compile");
  }));
}

test("consumer never overlays an existing prebuild or sysroot", () => withFixture("true", h => {
  seed(h);
  const digest = pack(h);
  mkdirSync(h.prebuild, { recursive: true });
  writeFileSync(join(h.prebuild, "owner-file"), "keep");
  expect(consume(h, digest).status).not.toBe(0);
  expect(existsSync(h.sysroot)).toBe(false);
  expect(readFileSync(join(h.prebuild, "owner-file"), "utf8")).toBe("keep");
}));

type GraphState = {
  quality: string; rust: string; prebuild: string;
  shared: boolean; sharedNative: boolean; cancelled: boolean;
};

function admitted(id: string, state: GraphState): boolean {
  const parsed: unknown = Bun.YAML.parse(job(id));
  assert(parsed && typeof parsed === "object" && "if" in parsed && typeof parsed.if === "string");
  const condition = parsed.if;
  const explicit = /\b(?:success|failure|always|cancelled)\(\)/.test(condition);
  const outcomes = id === "shared-prebuild" ? [state.quality] : [state.quality, state.rust, state.prebuild];
  const implicit = explicit || (!state.cancelled && outcomes.every(result => result === "success"));
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("github.event_name", '"pull_request"')
    .replaceAll("github.event.pull_request.draft", "false")
    .replaceAll("!cancelled()", String(!state.cancelled))
    .replaceAll("needs.quality.result", JSON.stringify(state.quality))
    .replaceAll("needs.quality.outputs.shared-native", JSON.stringify(String(state.sharedNative)))
    .replaceAll("needs.quality.outputs.shared", JSON.stringify(String(state.shared)));
  const result: unknown = new Function(`return (${expression})`)();
  assert(typeof result === "boolean");
  return implicit && result;
}

test("selection and failure paths keep the shared checks blocking even when Rust is skipped or fails", () => {
  const base = { quality: "success", rust: "success", prebuild: "success", cancelled: false };
  for (const [shared, sharedNative] of [[false, false], [true, false], [false, true], [true, true]] satisfies [boolean, boolean][]) {
    const state = { ...base, shared, sharedNative };
    expect(admitted("shared-prebuild", state)).toBe(shared || sharedNative);
    expect(admitted("shared-sysroot", state)).toBe(shared || sharedNative);
  }
  const selected = { ...base, shared: true, sharedNative: false };
  for (const result of ["failure", "cancelled", "skipped"]) {
    expect(admitted("shared-prebuild", { ...selected, rust: result })).toBe(true);
    expect(admitted("shared-sysroot", { ...selected, rust: result, prebuild: result })).toBe(true);
  }
  for (const id of ["shared-prebuild", "shared-sysroot"]) {
    expect(admitted(id, { ...selected, quality: "failure" })).toBe(false);
    expect(admitted(id, { ...selected, cancelled: true })).toBe(false);
  }
});

test("producer and consumer use identical pinned sysroot tools and the ordinary verified Binaryen archive cache", () => {
  const producer = steps("shared-prebuild");
  const consumer = steps("shared-sysroot");
  for (const name of ["Configure private shared sysroot paths", "Install pinned shared build tools", "Install pinned WASI SDK", "Prepare shared-profile Binaryen"]) {
    expect(command("shared-prebuild", name)).toBe(command("shared-sysroot", name));
  }
  for (const id of ["shared-sdk", "shared-binaryen"]) {
    expect(producer.find(item => item.id === id)?.with).toEqual(consumer.find(item => item.id === id)?.with);
  }
  expect(producer.find(item => item.id === "shared-binaryen")?.with).toEqual({
    path: "${{ env.WASM_TOOLS }}/binaryen-version_133-x86_64-linux.tar.gz",
    key: "binaryen-133-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/ci-binaryen.ts') }}",
  });
});
