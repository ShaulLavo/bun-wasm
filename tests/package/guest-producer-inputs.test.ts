import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, writeGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { hash } from "../../scripts/guest-source-manifest.ts";
import { fixtureGit, receiptCli, withCliReceiptFixture, withReceiptFixture } from "./guest-receipt-fixture.ts";
import { quickjsPair } from "./quickjs-plan-fixture.ts";
import { appendCustomSection, ENGINE_SECTION, programKind } from "../../src/engine-kind.ts";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

function quickjsNativeProducerFragment(): string {
  const step = workflow.split("      - name: Build native fixtures after the cache checkpoint\n")[1]?.split("\n      - ")[0];
  const native = step?.match(/^        run: \|\n([^]*)$/m)?.[1];
  if (!native) throw new Error("Missing native fixture producer workflow fragment");
  const start = native.indexOf('          export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  if (start < 0) throw new Error("Missing split producer core directory command");
  const end = native.indexOf("\n          bun scripts/test-checks.ts native", start);
  if (end < 0) throw new Error("Missing split producer test boundary");
  return ["set -euo pipefail", "source env.sh", native.slice(start, end)]
    .join("\n").replace(/^ {10}/gm, "");
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
  await writeFile(join(root, "env.sh"), `export TMPDIR=${JSON.stringify(temporary)}\n`);
  await copyFile(new URL("../../scripts/build.sh", import.meta.url), join(root, "scripts/build.sh"));
  await writeFile(join(root, "scripts/build-wasi-sysroot.ts"), "export {};\n");
  await executable(join(root, "scripts/sync-crypto.sh"), "exit 0");
  await executable(join(root, "scripts/test-transpiler-example.sh"), "exit 0");
  const { core, side } = quickjsPair();
  const tagBytes = appendCustomSection(new Uint8Array(), ENGINE_SECTION, new TextEncoder().encode("quickjs")).length;
  await writeFile(join(root, "private/common-core.wasm"), core.subarray(0, core.length - tagBytes));
  await writeFile(join(root, "private/quickjs.wasm"), side);
  await executable(join(root, "scripts/build-bun-core.sh"), `
if [ "${status}" != 0 ]; then exit ${status}; fi
mkdir -p "$BUN_CORE_BUILD_DIR"
printf '%s\\n' '{"features":["engine-split","bun-transpiler","bun-build"]}' > private/core-profile.json
bun scripts/guest-core-receipt.ts inputs private/core-profile.json > private/core-inputs.json
cp private/common-core.wasm "$BUN_CORE_BUILD_DIR/bun-core.wasm"
bun scripts/guest-core-receipt.ts write "$BUN_CORE_BUILD_DIR/bun-core.wasm" private/core-inputs.json
`);
  await executable(join(root, "scripts/build-engine-quickjs.sh"), `
mkdir -p "$QUICKJS_BUILD_DIR"
bun scripts/guest-engine-receipt.ts inputs quickjs > private/engine-inputs.json
cp private/quickjs.wasm "$QUICKJS_BUILD_DIR/engine.wasm"
bun scripts/guest-engine-receipt.ts write "$QUICKJS_BUILD_DIR/engine.wasm" private/engine-inputs.json
`);
  fixtureGit(root, "add", "scripts", "env.sh");
  fixtureGit(root, "commit", "-m", "synthetic producer inputs for actual wrapper, no compilation");
  fixture.env.CARGO_TARGET_DIR = join(root, "private/target");
  return { core, side, temporary };
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
