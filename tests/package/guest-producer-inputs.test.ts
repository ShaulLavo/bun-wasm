import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, writeGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { hash } from "../../scripts/guest-source-manifest.ts";
import { parseProgramReceipt, record } from "../../scripts/guest-core-receipt.ts";
import { fixtureGit, receiptCli, withCliReceiptFixture, withReceiptFixture } from "./guest-receipt-fixture.ts";
import { quickjsPair } from "./quickjs-plan-fixture.ts";
import { appendCustomSection, ENGINE_SECTION, programKind } from "../../src/engine-kind.ts";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

function quickjsNativeProducerFragment(): string {
  const parsed: unknown = Bun.YAML.parse(workflow);
  const steps = workflowField(workflowField(workflowField(parsed, "jobs"), "rust"), "steps");
  if (!Array.isArray(steps)) throw new Error("Expected native workflow steps");
  const step = steps.find(step => typeof step === "object" && step !== null && "name" in step && step.name === "Build native fixtures after the cache checkpoint");
  const native = workflowField(step, "run");
  if (typeof native !== "string") throw new Error("Missing native fixture producer workflow fragment");
  const start = native.indexOf('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  if (start < 0) throw new Error("Missing split producer core directory command");
  return ["set -euo pipefail", "source env.sh", native.slice(start)].join("\n");
}

function workflowField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) throw new Error(`Missing workflow field: ${key}`);
  return Reflect.get(value, key);
}

function jscPathSetup(jsc: boolean): string {
  const parsed: unknown = Bun.YAML.parse(workflow);
  const steps = workflowField(workflowField(workflowField(parsed, "jobs"), "rust"), "steps");
  if (!Array.isArray(steps)) throw new Error("Expected native workflow steps");
  const matches: unknown[] = steps.filter(step => typeof step === "object" && step !== null && "name" in step && step.name === "Configure private JSC build paths");
  expect(matches).toHaveLength(1);
  const step = matches[0];
  const run = workflowField(step, "run");
  if (typeof run !== "string") throw new Error("Expected JSC path setup shell");
  if (typeof step !== "object" || step === null || !("if" in step)) return run;
  expect(step.if).toBe("needs.quality.outputs.jsc == 'true'");
  return jsc ? run : "";
}

test("native-only workflow paths give tools receipts the real JSC and Yarr inputs", async () => {
  await withCliReceiptFixture(async fixture => {
    const runner = join(fixture.root, "private/runner");
    const prebuild = join(runner, "jsc/prebuild");
    await mkdir(dirname(prebuild), { recursive: true });
    await rename(join(fixture.root, "jsc-build"), prebuild);
    fixture.env.JSC_BUILD_DIR = join(runner, "unprovisioned-jsc");
    const missing = receiptCli(fixture, "inputs", "tools");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain(fixture.env.JSC_BUILD_DIR);
    fixture.env.RUNNER_TEMP = runner;
    fixture.env.GITHUB_ENV = join(runner, "github-env");
    await writeFile(fixture.env.GITHUB_ENV, "");
    const setup = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", jscPathSetup(false)], { cwd: fixture.root, env: fixture.env });
    expect(setup.exitCode).toBe(0);
    const environment = await readFile(fixture.env.GITHUB_ENV, "utf8");
    expect(environment).toContain(`JSC_BUILD_DIR=${prebuild}\n`);
    for (const line of environment.trim().split("\n")) {
      const separator = line.indexOf("=");
      expect(separator).toBeGreaterThan(0);
      fixture.env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    expect(fixture.env.JSC_BUILD_DIR).toBe(prebuild);
    expect(fixture.env.JSC_ENGINE_BUILD_DIR).toBe(join(runner, "jsc/engine"));
    const inputs = receiptCli(fixture, "inputs", "tools");
    expect(inputs.stderr.toString()).toBe("");
    expect(inputs.exitCode).toBe(0);
    const snapshot = join(runner, "tools-inputs.json");
    await writeFile(snapshot, inputs.stdout);
    const artifact = join(fixture.root, "dist/bun-tools.wasm");
    await copyFile(fixture.artifact, artifact);
    const finished = receiptCli(fixture, "write", artifact, snapshot);
    expect(finished.stderr.toString()).toBe("");
    expect(finished.exitCode).toBe(0);
    const receipt: unknown = await Bun.file(`${artifact}.build.json`).json();
    verifyGuestBuildReceipt(await readFile(artifact), receipt);
    expect(receipt.sourceManifest.build).toBe("tools");
    const paths = receipt.sourceManifest.groups.find(group => group.name === "jsc-prebuild")?.files.map(file => file.path);
    const yarr = "build/jsc/JavaScriptCore/DerivedSources/yarr/YarrCanonicalizeUnicode.cpp";
    expect(paths).toEqual(expect.arrayContaining(["build/jsc/.bunwasm-inputs", "webkit/Source/JavaScriptCore/yarr/YarrPattern.cpp", "webkit/Source/JavaScriptCore/runtime/OptionsList.h", yarr]));
    await rm(join(prebuild, yarr));
    await rm(`${artifact}.build.json`);
    const partial = receiptCli(fixture, "inputs", "tools");
    expect(partial.exitCode).not.toBe(0);
    expect(partial.stderr.toString()).toContain(yarr);
    expect(receiptCli(fixture, "write", artifact, snapshot).exitCode).not.toBe(0);
    expect(await Bun.file(`${artifact}.build.json`).exists()).toBe(false);
  });
});

async function executable(path: string, source: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${source}\n`);
  await chmod(path, 0o700);
}

test("hermetic receipt validator checks actual Wasm bytes without a native toolchain", async () => {
  await withCliReceiptFixture(async fixture => {
    const validator = join(fixture.root, "sdk/bin/wasm-tools");
    const validate = (path: string) => Bun.spawnSync([validator, "validate", path], { cwd: fixture.root, env: fixture.env });
    expect(validate(fixture.artifact).exitCode).toBe(0);
    const invalid = join(fixture.root, "private/invalid.wasm");
    await writeFile(invalid, new Uint8Array([0, 97, 115, 109, 0]));
    const rejected = validate(invalid);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain("Invalid fixture Wasm");
  });
});

async function snapshot(fixture: Parameters<typeof receiptCli>[0]) {
  const started = receiptCli(fixture, "inputs", "browser");
  expect(started.stderr.toString()).toBe("");
  expect(started.exitCode).toBe(0);
  const path = join(fixture.root, "dist/inputs.json");
  await writeFile(path, started.stdout);
  return path;
}

for (const path of ["decrepit/cfb/cfb.cc", "decrepit/blowfish/blowfish.cc", "decrepit/macros.h"]) test(`producer inventory rejects compiled BoringSSL drift: ${path}`, async () => {
  await withCliReceiptFixture(async fixture => {
    await writeFile(join(fixture.root, "vendor/boringssl", path), "original compiled input\n");
    const inputs = await snapshot(fixture);
    await writeFile(join(fixture.root, "vendor/boringssl", path), "changed compiled source\n");
    const finished = receiptCli(fixture, "write", fixture.artifact, inputs);
    expect(finished.exitCode).not.toBe(0);
    expect(finished.stderr.toString()).toContain("changed during the build");
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});

for (const override of ["", "private/runtime-override"]) test(`qualified CLI refuses selected runtime override ${JSON.stringify(override)}`, async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env.BUNWASM_JS_OVERRIDE_DIR = override;
    const started = receiptCli(fixture, "inputs", "browser");
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr.toString()).toContain("BUNWASM_JS_OVERRIDE_DIR");
  });
});

test("runtime override selected after snapshot cannot get a receipt", async () => {
  await withCliReceiptFixture(async fixture => {
    const inputs = await snapshot(fixture);
    fixture.env.BUNWASM_JS_OVERRIDE_DIR = "private/runtime-override";
    expect(receiptCli(fixture, "write", fixture.artifact, inputs).exitCode).not.toBe(0);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) for (const path of ["src/input.rs", "Cargo.toml", "Cargo.lock"]) test(`imported Bun ${path} cannot hide changes behind ${flag}`, async () => {
  await withReceiptFixture(async options => {
    const vendor = join(options.repository, "vendor/bun");
    fixtureGit(vendor, "update-index", flag, path);
    await writeFile(join(vendor, path), "hidden dirty input\n");
    const indexBefore = hash(await readFile(join(vendor, ".git/index")));
    const flagsBefore = fixtureGit(vendor, "ls-files", "-v");
    expect(fixtureGit(vendor, "status", "--porcelain")).toBe("");
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("differs from committed source");
    expect(hash(await readFile(join(vendor, ".git/index")))).toBe(indexBefore);
    expect(fixtureGit(vendor, "ls-files", "-v")).toBe(flagsBefore);
    expect(await readFile(join(vendor, path), "utf8")).toBe("hidden dirty input\n");
  });
});

test("hidden imported source drift after snapshot is refused", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    const vendor = join(options.repository, "vendor/bun");
    fixtureGit(vendor, "update-index", "--assume-unchanged", "src/input.rs");
    await writeFile(join(vendor, "src/input.rs"), "hidden during build\n");
    await expect(writeGuestBuildReceipt(options, artifact, inputs)).rejects.toThrow("differs from committed source");
  });
});

test("CLI resolves the selected Node dispatcher and Rust linker to consumed executables", async () => {
  await withCliReceiptFixture(async fixture => {
    const inputs = JSON.parse(await readFile(await snapshot(fixture), "utf8"));
    expect(inputs.sourceManifest.tools).toContainEqual({ name: "node", path: fixture.node, sha256: hash(await readFile(fixture.node)), version: "fixture node 1" });
    expect(inputs.sourceManifest.tools).toContainEqual({ name: "rust-lld", path: fixture.linker, sha256: hash(await readFile(fixture.linker)), version: "fixture rust-lld 1" });
    expect(inputs.sourceManifest.tools.find((tool: { name: string }) => tool.name === "rustc").path).toBe(fixture.rustc);
  });
});

for (const tool of ["node", "linker", "rustc"] as const) test(`CLI rejects actual ${tool} byte drift behind same-version probes`, async () => {
  await withCliReceiptFixture(async fixture => {
    const inputs = await snapshot(fixture);
    await writeFile(fixture[tool], (await readFile(fixture[tool], "utf8")) + "# changed actual executable\n");
    expect(receiptCli(fixture, "write", fixture.artifact, inputs).exitCode).not.toBe(0);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});

test("CLI refuses an unresolved explicit forwarding compiler", async () => {
  await withCliReceiptFixture(async fixture => {
    const shim = join(fixture.root, "private/rustc-shim");
    await executable(shim, `exec ${JSON.stringify(fixture.rustc)} "$@"`);
    fixture.env.RUSTC = shim;
    const started = receiptCli(fixture, "inputs", "browser");
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr.toString()).toContain("RUSTC");
  });
});

test("producer environment pins the inventoried compiler, cargo, Node and linker", async () => {
  await withCliReceiptFixture(async fixture => {
    const selected = receiptCli(fixture, "environment");
    expect(selected.exitCode).toBe(0);
    const probe = Bun.spawnSync(["bash", "-eu", "-c", `${selected.stdout}\nprintf '%s\\n' "$RUSTC" "$GUEST_CARGO" "$CARGO_TARGET_WASM32_WASIP1_LINKER"; command -v node`], { env: fixture.env, cwd: fixture.root });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString().trim().split("\n")).toEqual([fixture.rustc, join(fixture.root, "fake-tool"), fixture.linker, fixture.node]);
  });
});

for (const name of ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_TARGET_WASM32_WASIP1_LINKER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS"]) test(`qualified CLI refuses unsupported compiler selection via ${name}`, async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env[name] = name.includes("FLAGS") ? "-C linker=/unresolved/linker" : fixture.node;
    const started = receiptCli(fixture, "inputs", "browser");
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr.toString()).toContain(name);
  });
});

test("explicit active compiler is accepted and a Node dispatcher retarget is detected", async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env.RUSTC = fixture.rustc;
    const inputs = await snapshot(fixture);
    const alternate = join(fixture.root, "private/alternate/bin/node");
    await executable(alternate, `if [ "$1" = "-p" ]; then echo ${JSON.stringify(alternate)}; else echo 'fixture node 1'; fi`);
    await executable(join(fixture.root, "sdk/bin/node"), `exec ${JSON.stringify(alternate)} "$@"`);
    expect(receiptCli(fixture, "write", fixture.artifact, inputs).exitCode).not.toBe(0);
  });
});

async function browserProducerFixture(fixture: Parameters<typeof receiptCli>[0]) {
  const root = fixture.root;
  await copyFile(new URL("../../scripts/build-bun-browser.sh", import.meta.url), join(root, "scripts/build-bun-browser.sh"));
  await writeFile(join(root, "scripts/build-wasi-sysroot.ts"), "export {};\n");
  await executable(join(root, "scripts/sync-crypto.sh"), "exit 0");
  await writeFile(join(root, "env.sh"), `export TMPDIR=${JSON.stringify(join(root, "private"))}\n`);
  fixtureGit(root, "add", "scripts", "env.sh");
  fixtureGit(root, "commit", "-m", "synthetic browser producer, no compiler invocation");
  const raw = join(root, "private/target/wasm32-wasip1/release/bun.wasm");
  await executable(join(root, "fake-tool"), `
if [ "$1" = build ]; then
  printf '%s\\n' "$RUSTC" "$CARGO_TARGET_WASM32_WASIP1_LINKER" "$(command -v node)" > ${JSON.stringify(join(root, "dist/producer.txt"))}
  mkdir -p ${JSON.stringify(dirname(raw))}
  printf '\\000asm\\001\\000\\000\\000' > ${JSON.stringify(raw)}
  exit 0
fi
if [ "$1" = -O2 ]; then
  while [ "$1" != -o ]; do shift; done
  cp ${JSON.stringify(raw)} "$2"
  exit 0
fi
echo 'fixture tool 1'
`);
  fixture.env.BROWSER_CARGO_TARGET_DIR = join(root, "private/target");
  return Bun.spawnSync(["bash", join(root, "scripts/build-bun-browser.sh")], { env: fixture.env, cwd: root });
}

test("actual browser entry point uses pinned tools for a fixture-only artifact producer", async () => {
  await withCliReceiptFixture(async fixture => {
    const finished = await browserProducerFixture(fixture);
    expect(finished.stderr.toString()).toBe("");
    expect(finished.exitCode).toBe(0);
    expect((await readFile(join(fixture.root, "dist/producer.txt"), "utf8")).trim().split("\n")).toEqual([fixture.rustc, fixture.linker, fixture.node]);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(true);
  });
});

test("actual browser entry point stops before a fixture producer on an unresolved compiler", async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env.RUSTC = fixture.node;
    const finished = await browserProducerFixture(fixture);
    expect(finished.exitCode).not.toBe(0);
    expect(finished.stderr.toString()).toContain("RUSTC");
    expect(await Bun.file(join(fixture.root, "dist/producer.txt")).exists()).toBe(false);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});


async function quickjsWrapperFixture(fixture: Parameters<typeof receiptCli>[0], status: number) {
  const root = fixture.root;
  const temporary = join(root, "private/t");
  await mkdir(temporary, { recursive: true });
  await mkdir(join(root, "jsc"));
  for (const path of ["scripts/build.sh", "scripts/build-bun-core.sh", "scripts/build-engine-quickjs.sh", "scripts/build-engine-jsc.sh", "scripts/build-bun-jsc.sh", "jsc/common.sh", "jsc/finalize.sh"]) {
    await copyFile(new URL(`../../${path}`, import.meta.url), join(root, path));
    await chmod(join(root, path), 0o700);
  }
  await writeFile(join(root, "jsc/common.sh"), (await readFile(join(root, "jsc/common.sh"), "utf8")) + "\ncheck_jsc_inputs_stamp() { :; }\n");
  await writeFile(join(root, "scripts/jsc-embedding.ts"), 'if (process.argv[2] === "inputs") console.log("{}");\n');
  await writeFile(join(root, "env.sh"), `export TMPDIR=${JSON.stringify(temporary)}\nexport CC_wasm32_wasip1="$WASI_SDK_PATH/bin/clang"\n`);
  await writeFile(join(root, "scripts/build-wasi-sysroot.ts"), "export {};\n");
  await executable(join(root, "scripts/sync-crypto.sh"), "exit 0");
  await executable(join(root, "scripts/test-transpiler-example.sh"), "exit 0");
  const { core, side } = quickjsPair();
  const tagBytes = appendCustomSection(new Uint8Array(), ENGINE_SECTION, new TextEncoder().encode("quickjs")).length;
  await writeFile(join(root, "private/common-core.wasm"), core.subarray(0, core.length - tagBytes));
  await writeFile(join(root, "private/quickjs.wasm"), side);
  await writeFile(join(root, "private/jsc.wasm"), quickjsPair("jsc").side);
  await writeFile(join(root, "jsc-build/build/jsc/lib/libWTF.a"), "synthetic BUN_WASM_STACK_KIB\n");
  await mkdir(join(root, "crates/bunwasm-engine-jsc/src"), { recursive: true });
  await writeFile(join(root, "crates/bunwasm-engine-jsc/src/vm.rs"), "JSC source fixture\n");
  await writeFile(join(root, "crates/bunwasm-engine-quickjs/src/vm.rs"), "QuickJS source fixture\n");
  await executable(join(root, "fake-tool"), `
if [ "$1" = --version ]; then echo 'fixture tool 1'; exit 0; fi
if [ "$1" = tree ]; then echo 'bunwasm-cli v0.0.0'; exit 0; fi
if [ "$1" = fetch ]; then exit 0; fi
if [ "$1" = build ]; then
  kind=core
  for arg in "$@"; do
    case "$arg" in bunwasm-engine-quickjs) kind=quickjs;; bunwasm-engine-jsc) kind=jsc;; esac
  done
  printf '%s\n' "$kind" >> private/recipe-builds.log
  if [ "${status}" != 0 ]; then exit ${status}; fi
  output="$CARGO_TARGET_DIR/wasm32-wasip1/release"
  mkdir -p "$output"
  cp private/common-core.wasm "$output/bun.wasm"
  printf captured > "$output/libbunwasm_engine_quickjs.a"
  printf captured > "$output/libbunwasm_engine_jsc.a"
  exit 0
fi
case "\${0##*/}" in
  clang|clang++|wasm-ld)
    while [ "$1" != -o ]; do shift; done
    printf captured > "$2"; exit 0;;
  wasm-opt)
    while [ "$1" != -o ]; do shift; done
    cp private/common-core.wasm "$2"; exit 0;;
esac
printf 'fixture tool 1\n'
`);
  await executable(fixture.node, `
if [ "$1" = -p ]; then echo ${JSON.stringify(fixture.node)}; exit 0; fi
if [ "$1" = --version ]; then echo 'fixture node 1'; exit 0; fi
cp "private/$2.wasm" "$4"
`);
  await writeFile(fixture.rustc, `#!/bin/sh
if [ "$1" = -vV ] && [ -n "\${FIXTURE_DRIFT_AT:-}" ]; then
  count=$(cat private/drift-count 2>/dev/null || echo 0)
  count=$((count + 1)); echo "$count" > private/drift-count
  if [ "$count" = "$FIXTURE_DRIFT_AT" ]; then echo drift >> crates/fixture/src/lib.rs; fi
fi
` + (await readFile(fixture.rustc, "utf8")).replace(/^#![^\n]*\n/, ""));
  fixtureGit(root, "add", "scripts", "env.sh", "jsc", "crates");
  fixtureGit(root, "commit", "-m", "real source recipes with captured compilers and real receipts");
  fixture.env.CARGO_TARGET_DIR = join(root, "private/target");
  fixture.env.JSC_BUILD_DIR = join(root, "jsc-build");
  fixture.env.JSC_ENGINE_BUILD_DIR = join(root, "private/jsc-engine");
  fixture.env.CAGE = "";
  const paths = { core: join(root, "private/target/split-common/bun-core.wasm"), quickjs: join(root, "private/target/split-common/quickjs/engine.wasm"), jsc: join(root, "private/jsc-engine/engine.wasm") };
  const run = (kind: "quickjs" | "jsc") => Bun.spawnSync(["bash", join(root, kind === "jsc" ? "scripts/build-bun-jsc.sh" : "scripts/build.sh")], { cwd: root, env: fixture.env });
  const builds = async () => (await readFile(join(root, "private/recipe-builds.log"), "utf8")).trim().split("\n");
  return { core, side, temporary, paths, run, builds };
}

for (const status of [0, 42]) test(`executed native workflow wrapper publishes a tagged pair and cleans its snapshot after captured producer status ${status}`, async () => {
  await withCliReceiptFixture(async fixture => {
    const expected = await quickjsWrapperFixture(fixture, status);
    const finished = Bun.spawnSync(["bash", "-eu", "-o", "pipefail", "-c", quickjsNativeProducerFragment()], { cwd: fixture.root, env: fixture.env });
    expect(finished.stderr.toString()).toBe("");
    expect(finished.exitCode).toBe(status);
    expect(await readdir(expected.temporary)).toEqual([]);
    const artifact = join(fixture.root, "dist/bun.wasm");
    if (status !== 0) {
      expect(await Bun.file(`${artifact}.build.json`).exists()).toBe(false);
      return;
    }
    const core = await readFile(artifact);
    const side = await readFile(join(fixture.root, "dist/quickjs.wasm"));
    expect(core).toEqual(Buffer.from(expected.core));
    expect(side).toEqual(Buffer.from(expected.side));
    expect(programKind(new WebAssembly.Module(core))).toBe("quickjs");
    const receipt: unknown = await Bun.file(`${artifact}.build.json`).json();
    verifyGuestBuildReceipt(core, receipt);
    expect(receipt.sourceManifest.build).toBe("quickjs");
    expect(receipt.program.kind).toBe("quickjs");
    if (receipt.program.kind !== "quickjs") throw new Error("Expected QuickJS pair");
    expect(receipt.program.side).toEqual({ artifactSha256: hash(side), artifactBytes: side.length });
    expect(await Bun.file(join(fixture.root, "dist/quickjs.wasm.engine.json")).exists()).toBe(true);
  });
});

function succeeded(result: ReturnType<typeof Bun.spawnSync>) {
  expect(result.exitCode, result.stderr?.toString()).toBe(0);
}

async function committedDelta(root: string, path: string) {
  await writeFile(join(root, path), "changed source input\n");
  fixtureGit(root, "add", path);
  fixtureGit(root, "commit", "-m", `source delta ${path}`);
}

async function finalFiles(paths: { core: string; quickjs: string; jsc: string }) {
  const files = [paths.core, `${paths.core}.core.json`, paths.quickjs, `${paths.quickjs}.engine.json`, paths.jsc, `${paths.jsc}.engine.json`];
  return Promise.all(files.map(async path => ({ path, bytes: await Bun.file(path).exists() ? hash(await readFile(path)) : null })));
}

test("real wrappers retain engines across a core delta and rebuild only each changed engine", async () => {
  await withCliReceiptFixture(async fixture => {
    const recipe = await quickjsWrapperFixture(fixture, 0);
    succeeded(recipe.run("quickjs"));
    succeeded(recipe.run("jsc"));
    expect(await recipe.builds()).toEqual(["core", "quickjs", "jsc"]);
    const quickjsOrigin = await readFile(`${recipe.paths.quickjs}.engine.json`, "utf8");
    const jscOrigin = await readFile(`${recipe.paths.jsc}.engine.json`, "utf8");
    const coreOrigin = await readFile(`${recipe.paths.core}.core.json`, "utf8");
    await committedDelta(fixture.root, "crates/fixture/src/lib.rs");
    succeeded(recipe.run("quickjs"));
    succeeded(recipe.run("jsc"));
    expect(await recipe.builds()).toEqual(["core", "quickjs", "jsc", "core"]);
    expect(await readFile(`${recipe.paths.core}.core.json`, "utf8")).not.toBe(coreOrigin);
    expect(await readFile(`${recipe.paths.quickjs}.engine.json`, "utf8")).toBe(quickjsOrigin);
    expect(await readFile(`${recipe.paths.jsc}.engine.json`, "utf8")).toBe(jscOrigin);
    const coreAfter = await readFile(`${recipe.paths.core}.core.json`, "utf8");
    await committedDelta(fixture.root, "crates/bunwasm-engine-quickjs/src/vm.rs");
    succeeded(recipe.run("quickjs"));
    succeeded(recipe.run("jsc"));
    expect(await recipe.builds()).toEqual(["core", "quickjs", "jsc", "core", "quickjs"]);
    expect(await readFile(`${recipe.paths.core}.core.json`, "utf8")).toBe(coreAfter);
    expect(await readFile(`${recipe.paths.jsc}.engine.json`, "utf8")).toBe(jscOrigin);
    const quickjsAfter = await readFile(`${recipe.paths.quickjs}.engine.json`, "utf8");
    expect(quickjsAfter).not.toBe(quickjsOrigin);
    await committedDelta(fixture.root, "crates/bunwasm-engine-jsc/src/vm.rs");
    succeeded(recipe.run("jsc"));
    succeeded(recipe.run("quickjs"));
    expect(await recipe.builds()).toEqual(["core", "quickjs", "jsc", "core", "quickjs", "jsc"]);
    expect(await readFile(`${recipe.paths.jsc}.engine.json`, "utf8")).not.toBe(jscOrigin);
    expect(await readFile(`${recipe.paths.quickjs}.engine.json`, "utf8")).toBe(quickjsAfter);
    expect(await readFile(`${recipe.paths.core}.core.json`, "utf8")).toBe(coreAfter);
    for (const path of [join(dirname(recipe.paths.core), "core-target"), join(dirname(recipe.paths.quickjs), "target"), join(dirname(recipe.paths.jsc), "target")]) expect(await Bun.file(join(path, "wasm32-wasip1/release/bun.wasm")).exists()).toBe(true);
    expect(await readdir(recipe.temporary)).toEqual([]);
  });
}, 30_000);

for (const kind of ["quickjs", "jsc"] as const) for (const damage of ["corrupt", "partial", "wrong-scope", "wrong-profile", "input-hash", "command-profile"]) {
  test(`${kind} wrapper preserves ${damage} output plus a source delta without retirement or compilation`, async () => {
    await withCliReceiptFixture(async fixture => {
      const recipe = await quickjsWrapperFixture(fixture, 0);
      succeeded(recipe.run(kind));
      const side = recipe.paths[kind];
      const receiptPath = `${side}.engine.json`;
      if (damage === "corrupt") await writeFile(side, "corrupt retained bytes");
      if (damage === "partial") await rm(receiptPath);
      if (damage === "wrong-profile") await writeFile(side, quickjsPair(kind === "jsc" ? "quickjs" : "jsc").side);
      if (damage === "wrong-scope" || damage === "input-hash" || damage === "wrong-profile" || damage === "command-profile") {
        const receipt = parseProgramReceipt(await Bun.file(receiptPath).json());
        if (!record(receipt.inputs.content)) throw new Error("Missing fixture content");
        const content = damage === "command-profile" ? { ...receipt.inputs.content, command: { target: "native" } } : receipt.inputs.content;
        const inputs = damage === "wrong-scope" ? { ...receipt.inputs, scope: "core" }
          : { ...receipt.inputs, content, contentSha256: damage === "input-hash" ? "0".repeat(64) : hash(JSON.stringify(content)) };
        const artifact = damage === "wrong-profile" ? { artifactSha256: hash(await readFile(side)), artifactBytes: (await readFile(side)).length } : receipt.artifact;
        await writeFile(receiptPath, JSON.stringify({ ...receipt, inputs, artifact }));
      }
      await committedDelta(fixture.root, "crates/fixture/src/lib.rs");
      const files = await finalFiles(recipe.paths);
      const builds = await recipe.builds();
      expect(recipe.run(kind).exitCode).not.toBe(0);
      expect(await finalFiles(recipe.paths)).toEqual(files);
      expect(await recipe.builds()).toEqual(builds);
    });
  }, 15_000);
}

test("wrapper preparation refuses start/end source drift before retiring valid stale outputs", async () => {
  await withCliReceiptFixture(async fixture => {
    const recipe = await quickjsWrapperFixture(fixture, 0);
    succeeded(recipe.run("quickjs"));
    await committedDelta(fixture.root, "crates/fixture/src/lib.rs");
    const files = await finalFiles(recipe.paths);
    const builds = await recipe.builds();
    const result = Bun.spawnSync([process.execPath, join(fixture.root, "scripts/guest-core-receipt.ts"), "prepare", "quickjs", recipe.paths.core, recipe.paths.quickjs], { cwd: fixture.root, env: { ...fixture.env, FIXTURE_DRIFT_AT: "4" } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("source changed");
    expect(await readFile(join(fixture.root, "private/drift-count"), "utf8")).not.toBe("");
    expect(await finalFiles(recipe.paths)).toEqual(files);
    expect(await recipe.builds()).toEqual(builds);
  });
}, 15_000);

for (const damage of ["corrupt", "partial", "profile"]) test(`core ${damage} plus source delta fails closed in composing caller`, async () => {
  await withCliReceiptFixture(async fixture => {
    const recipe = await quickjsWrapperFixture(fixture, 0);
    succeeded(recipe.run("quickjs"));
    if (damage === "corrupt") await writeFile(recipe.paths.core, "corrupt core");
    if (damage === "partial") await rm(`${recipe.paths.core}.core.json`);
    if (damage === "profile") {
      const path = `${recipe.paths.core}.core.json`;
      const receipt = parseProgramReceipt(await Bun.file(path).json());
      if (!receipt.inputs.content || typeof receipt.inputs.content !== "object") throw new Error("Missing fixture input content");
      const content = { ...receipt.inputs.content, selection: { features: ["engine-split"] } };
      await writeFile(path, JSON.stringify({ ...receipt, inputs: { ...receipt.inputs, content, contentSha256: hash(JSON.stringify(content)) } }));
    }
    await committedDelta(fixture.root, "crates/fixture/src/lib.rs");
    const files = await finalFiles(recipe.paths);
    const builds = await recipe.builds();
    expect(recipe.run("quickjs").exitCode).not.toBe(0);
    expect(await finalFiles(recipe.paths)).toEqual(files);
    expect(await recipe.builds()).toEqual(builds);
  });
}, 15_000);
