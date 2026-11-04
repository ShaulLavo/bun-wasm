import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolPins, installBuildTools, verifyBuildToolArchive } from "./ci-build-tools";

const repo = join(import.meta.dir, "..");
type Step = Record<string, unknown>;
const workflow = Bun.YAML.parse(readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: Step[] }> };
const installName = "Install pinned CMake and Ninja";

function withRoot(body: (root: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-build-tools-"));
  return Promise.resolve(body(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

for (const pin of buildToolPins) for (const contents of ["tampered archive", ""]) {
  test(`${pin.name} setup rejects a ${contents ? "tampered" : "empty"} cached archive`, () => withRoot(async root => {
    const archive = join(root, pin.archive);
    writeFileSync(archive, contents);
    await expect(verifyBuildToolArchive(pin, archive)).rejects.toThrow(`${pin.name} archive checksum mismatch`);
  }));
}

test("build tool setup rejects a tampered cache before extracting anything", () => withRoot(async root => {
  const first = buildToolPins[0];
  writeFileSync(join(root, first.archive), "tampered archive");
  await expect(installBuildTools(root)).rejects.toThrow("checksum mismatch");
  expect(readdirSync(root)).toEqual([first.archive]);
}));

test("build tool setup requires explicit runner-owned paths before doing work", () => {
  const run = spawnSync(process.execPath, [join(import.meta.dir, "ci-build-tools.ts")], { env: { ...process.env, WASM_TOOLS: "", GITHUB_PATH: "" }, encoding: "utf8" });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("Set WASM_TOOLS and GITHUB_PATH");
});

test("every JSC stamp and sysroot job installs the pinned tools before identifying or using them", () => {
  for (const id of ["jsc-prebuild", "native-quality", "rust"]) {
    const steps = workflow.jobs[id]!.steps;
    const install = steps.findIndex(step => step.name === installName);
    expect(install, id).toBeGreaterThan(0);
    const restore = steps[install - 1]!, save = steps[install + 1]!;
    expect(restore.uses).toBe("actions/cache/restore@v4");
    expect(restore.id).toBe("build-tools-cache");
    const paths = buildToolPins.map(pin => `\${{ env.WASM_TOOLS }}/${pin.archive}`).join("\n") + "\n";
    expect((restore.with as Step).path).toBe(paths);
    expect((restore.with as Step).key).toBe("build-tools-cmake-4.4.5-ninja-1.13.2-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/ci-build-tools.ts') }}");
    expect(save.uses).toBe("actions/cache/save@v4");
    expect(save.if).toBe("steps.build-tools-cache.outputs.cache-hit != 'true'");
    expect((save.with as Step).path).toBe(paths);
    expect(steps[install]!.run).toBe("bun scripts/ci-build-tools.ts");
    const users = steps.flatMap((step, index) => /jsc\/common\.sh|build-wasi-sysroot\.ts|ci-native-handoff\.ts|cargo |id: host-tools/.test(String(step.run ?? "")) || step.id === "host-tools" ? [index] : []);
    expect(users.length, id).toBeGreaterThan(0);
    for (const index of users) expect(index, `${id}: ${String(steps[index]!.name)}`).toBeGreaterThan(install);
  }
  expect(buildToolPins.map(pin => pin.toolVersion)).toEqual(["cmake version 4.4.5", "1.13.2"]);
});

// Two runner images in one run: the producer job sees one preinstalled CMake, its consumer another.
function stub(path: string, output: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho '${output}'\n`, { mode: 0o755 });
}
function fixture(root: string, pinned: boolean): void {
  const tools = join(root, "wasm-tools");
  mkdirSync(join(tools, "wasi-sdk"), { recursive: true });
  writeFileSync(join(tools, "wasi-sdk/VERSION"), "34.0\n");
  for (const name of ["clang", "clang++", "llvm-ar", "llvm-nm", "llvm-ranlib"]) stub(join(tools, "wasi-sdk/bin", name), `${name} version 21 (wasi-sdk)`);
  for (const overlay of ["include/c++", "include/wasm32-wasip1/noeh", "lib/wasm32-wasip1/noeh"]) mkdirSync(join(tools, "wasi-sdk/share/wasi-sysroot", overlay), { recursive: true });
  stub(join(tools, "binaryen/bin/wasm-opt"), "wasm-opt version 133 (version_133)");
  mkdirSync(join(tools, "bun-wasm-sysroot-patched"), { recursive: true });
  writeFileSync(join(tools, "bun-wasm-sysroot-patched/bun-wasm-sysroot.json"), '{"receipt":true}');
  for (const [image, cmake] of [["image-new", "4.4.5"], ["image-old", "4.4.4"]] as const) {
    stub(join(root, image, "cmake"), `cmake version ${cmake}`);
    stub(join(root, image, "ninja"), "1.13.2");
  }
  if (pinned) {
    stub(join(tools, "cmake/bin/cmake"), "cmake version 4.4.5");
    stub(join(tools, "ninja/ninja"), "1.13.2");
  }
  mkdirSync(join(root, "waffle/scripts"), { recursive: true });
  mkdirSync(join(root, "waffle/patches/wasi-libc"), { recursive: true });
  writeFileSync(join(root, "waffle/scripts/build-wasi-libc.sh"), "exit 0\n");
  writeFileSync(join(root, "waffle/patches/wasi-libc/preopen-scan.patch"), "patch\n");
}
function job(root: string, image: string, script: string) {
  const env: Record<string, string> = {
    PATH: `${join(root, image)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: root, TMPDIR: join(root, "tmp"),
    WASM_TOOLS: join(root, "wasm-tools"), CARGO_HOME: join(root, "cargo"), RUSTUP_HOME: join(root, "rustup"),
    CARGO_TARGET_DIR: join(root, "target"), JSC_BUILD_DIR: join(root, "jsc"), CAGE: "", JOBS: "2", FIXTURE: root,
  };
  mkdirSync(env.TMPDIR!, { recursive: true });
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], { cwd: repo, env, encoding: "utf8", timeout: 20000 });
}
// The producer writes the real inputs stamp; the consumer recomputes it and runs the real check.
// The check's later WebKit Git identity step cannot be faked here, so only the inputs comparison
// that failed in hosted run 41803538617 decides these cases.
const produce = 'source jsc/common.sh; copy_jsc_config_inputs; mkdir -p "$(dirname "$JSC_INPUTS_STAMP")"; jsc_inputs_hash > "$JSC_INPUTS_STAMP"';
const consume = 'source jsc/common.sh; [[ "$(jsc_inputs_hash)" == "$(cat "$JSC_INPUTS_STAMP")" ]] && echo inputs-match; check_jsc_inputs_stamp';
const sysroot = `source env.sh; bun -e 'const { wasiSysrootInputs } = await import(process.cwd() + "/scripts/build-wasi-sysroot.ts"); const inputs = await wasiSysrootInputs({ waffle: process.env.FIXTURE + "/waffle", sdk: process.env.WASI_SDK_PATH }); console.log(JSON.stringify(inputs.tools.slice(4)))'`;
const inputsError = "was built from different JSC inputs";

for (const pinned of [false, true]) {
  test(`the real JSC stamp ${pinned ? "accepts" : "rejects"} a producer on another runner image ${pinned ? "with" : "without"} pinned CMake and Ninja`, () => withRoot(root => {
    fixture(root, pinned);
    const produced = job(root, "image-new", produce);
    expect(produced.status, produced.stderr).toBe(0);
    expect(readFileSync(join(root, "jsc/build/jsc/.bunwasm-inputs"), "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    const same = job(root, "image-new", consume);
    expect(same.stdout).toContain("inputs-match");
    expect(same.stderr).not.toContain(inputsError);
    const other = job(root, "image-old", consume);
    if (pinned) {
      expect(other.stdout).toContain("inputs-match");
      expect(other.stderr).not.toContain(inputsError);
      return;
    }
    expect(other.stdout).not.toContain("inputs-match");
    expect(other.status).toBe(1);
    expect(other.stderr).toContain(inputsError);
  }));

  test(`the real sysroot receipt inputs ${pinned ? "match" : "differ"} across runner images ${pinned ? "with" : "without"} pinned CMake and Ninja`, () => withRoot(root => {
    fixture(root, pinned);
    const [newer, older] = ["image-new", "image-old"].map(image => {
      const result = job(root, image, sysroot);
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    });
    if (pinned) expect(older).toBe(newer!);
    else expect(older).not.toBe(newer!);
  }));
}
