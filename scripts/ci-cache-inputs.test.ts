import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) throw new Error(`Missing workflow field: ${key}`);
  return Reflect.get(value, key);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected workflow string");
  return value;
}

const workflow: unknown = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
function jobSteps(job: string): unknown[] {
  const steps: unknown = field(field(field(workflow, "jobs"), job), "steps");
  if (!Array.isArray(steps)) throw new Error("Expected workflow steps");
  return steps;
}
const stepList = jobSteps("rust");
const producerSteps = jobSteps("jsc-prebuild");
function step(key: string, value: string, list: readonly unknown[] = stepList): unknown {
  const found = list.filter(item => typeof item === "object" && item !== null && key in item && Reflect.get(item, key) === value);
  expect(found).toHaveLength(1);
  return found[0];
}
const byId = (id: string, list: readonly unknown[] = stepList) => step("id", id, list);
const named = (name: string, list: readonly unknown[] = stepList) => step("name", name, list);
const position = (name: string, list: readonly unknown[] = stepList) => list.indexOf(named(name, list));

test("sysroot and prebuild restores use effective inputs and have bounded compatible fallbacks", () => {
  for (const [id, list] of [["sysroot-cache", producerSteps], ["jsc-prebuild-cache", producerSteps], ["jsc-cargo-cache", stepList]] satisfies [string, readonly unknown[]][]) {
    const restore = field(byId(id, list), "with");
    const prefix = string(field(restore, "restore-keys")).trim();
    expect(prefix).not.toContain("'bun.lock'");
    expect(prefix).not.toContain("'env.sh'");
    expect(prefix).toContain("outputs.hash");
    expect(string(field(restore, "key"))).toStartWith(prefix);
  }
});

test("native-only selections provision the tools JSC prerequisite without enabling JSC engine gates", () => {
  for (const path of ["crates/bunwasm-runtime/src/engine_quickjs.rs", "web/guest-tests/quickjs.test.ts"]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(false);
  }
  expect(field(field(field(workflow, "jobs"), "jsc-prebuild"), "if")).toBe("needs.quality.outputs.rust == 'true'");
  expect(field(field(field(workflow, "jobs"), "rust"), "if")).toBe("${{ !cancelled() && needs.quality.result == 'success' && needs.quality.outputs.rust == 'true' }}");
  for (const prerequisite of [named("Configure private JSC build paths", producerSteps), byId("jsc-inputs", producerSteps), byId("jsc-prebuild-cache", producerSteps), byId("jsc-producer", producerSteps), byId("jsc-artifact", producerSteps)]) {
    expect(prerequisite).not.toHaveProperty("if");
  }
  for (const prerequisite of [named("Require the JSC prebuild job's output"), named("Configure private JSC build paths"), named("Import the verified JSC prebuild and sysroot"), byId("jsc-inputs")]) {
    expect(prerequisite).not.toHaveProperty("if");
  }
  const tools = named("Build the single tools fixture in the existing native target");
  expect(tools).not.toHaveProperty("if");
  expect(position("Import the verified JSC prebuild and sysroot")).toBeLessThan(stepList.indexOf(tools));
  expect(position("Import the verified JSC prebuild and sysroot")).toBeLessThan(position("Blocking native quality checks"));
  for (const engine of [byId("jsc-cargo-cache"), named("Build the JSC Cargo guest"), named("Blocking JSC embedding and allocation checks"), named("Blocking Web guest case (JSC)")]) {
    expect(field(engine, "if")).toBe("needs.quality.outputs.jsc == 'true'");
  }
});

test("completed caches are saved before later validation can fail or time out", () => {
  expect(position("Save the verified sysroot cache", producerSteps)).toBeGreaterThan(position("Build patched WASI sysroot", producerSteps));
  expect(position("Save the verified sysroot cache", producerSteps)).toBeLessThan(position("Build or verify the JSC prebuild", producerSteps));
  expect(position("Save the JSC prebuild cache once per input revision", producerSteps)).toBeLessThan(position("Package the verified prebuild and sysroot", producerSteps));
  expect(position("Save the JSC Cargo cache once per input revision")).toBeLessThan(position("Blocking JSC embedding and allocation checks"));
  expect(position("Save the native quality checkpoint")).toBeLessThan(position("Build native fixtures after the cache checkpoint"));
  expect(position("Save the refined native Cargo cache once per input revision")).toBeLessThan(position("Blocking Web guest cases (QuickJS and host engine)"));
  expect(field(named("Save the JSC prebuild cache once per input revision", producerSteps), "if")).toContain("!cancelled()");
  expect(field(named("Save the JSC prebuild cache once per input revision", producerSteps), "if")).toContain("outputs.jsc-ready == 'true'");
});

test("split producers keep the common core target separate from the JSC side cache", () => {
  const native = string(field(named("Build native fixtures after the cache checkpoint"), "run"));
  expect(native).toContain('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  expect(native.match(/CARGO_BUILD_JOBS=2 bash scripts\/build\.sh/g)).toHaveLength(1);
  expect(native).not.toContain("build-bun-core.sh");
  const common = string(field(named("Build the common engine core once"), "run"));
  expect(common).toContain('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  expect(common.match(/bash scripts\/build-bun-core\.sh/g)).toHaveLength(1);
  expect(position("Build the common engine core once")).toBeLessThan(position("Start the JSC Cargo guest build"));
  const jsc = string(field(named("Start the JSC Cargo guest build"), "run"));
  expect(jsc).toContain('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  expect(string(field(named("Configure private JSC build paths"), "run"))).toContain('JSC_ENGINE_BUILD_DIR=$RUNNER_TEMP/jsc/engine');
  expect(jsc.match(/bash scripts\/build-bun-jsc\.sh/g)).toHaveLength(1);
  expect(string(field(field(byId("jsc-cargo-cache"), "with"), "path"))).toBe("${{ runner.temp }}/jsc/engine");
  expect(jsc).not.toContain("JSC_CARGO_TARGET_DIR=");
});

test("each setup cache has one immediate save after its successful producer", () => {
  for (const [id, producer, list] of [
    ["rustup-cache", "dtolnay/rust-toolchain@nightly", stepList], ["sdk", "Install pinned WASI SDK", stepList],
    ["binaryen-cache", "Install pinned Binaryen", stepList], ["wasmtime-cache", "Install pinned Wasmtime", stepList], ["sources-cache", "Prepare pinned upstream sources", stepList],
    ["sdk", "Install pinned WASI SDK", producerSteps], ["binaryen-cache", "Install pinned Binaryen", producerSteps],
  ] satisfies [string, string, readonly unknown[]][]) {
    const restore = byId(id, list);
    const output = named(`Save completed ${id} setup`, list);
    const build = step(id === "rustup-cache" ? "uses" : "name", producer, list);
    expect(list.indexOf(output)).toBe(list.indexOf(build) + 1);
    const scope = id === "sources-cache" ? "github.event_name == 'push' && github.ref == 'refs/heads/main' && " : "";
    expect(field(output, "if")).toBe(`${scope}steps.${id}.outputs.cache-hit != 'true'`);
    expect(field(field(output, "with"), "key")).toBe(`\${{ steps.${id}.outputs.cache-primary-key }}`);
    expect(field(field(output, "with"), "path")).toBe(field(field(restore, "with"), "path"));
  }
});

function shellFixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-cache-shell-"));
  try { run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("ordered producers advertise completion only after successful commands", () => {
  shellFixture(root => {
    for (const [name, functionName, outputName, list] of [
      ["Build or verify the JSC prebuild", "run_jsc_prebuild", "jsc-ready", producerSteps],
      ["Blocking native quality checks", "run_native_checks", "native-ready", stepList],
    ] satisfies [string, string, string, readonly unknown[]][]) {
      assertProducerCompletion(root, name, functionName, outputName, list);
    }
  });
});

function assertProducerCompletion(root: string, name: string, functionName: string, outputName: string, list: readonly unknown[]) {
  const original = string(field(named(name, list), "run"));
  for (const status of [0, 42]) {
    const output = join(root, "outputs");
    writeFileSync(output, "");
    const script = original.replace(new RegExp(`^${functionName}\\(\\) {\\n[^]*?^}`, "m"), () => `${functionName}() {\n  return ${status}\n}`);
    expect(script).not.toBe(original);
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
      env: { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output }, timeout: 3000,
    });
    expect(result.status).toBe(status);
    expect(readFileSync(output, "utf8")).toBe(status === 0 ? `${outputName}=true\n` : "");
  }
}

function nativeFingerprint(root: string, environment: Record<string, string> = {}) {
  const output = join(root, "inputs");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", string(field(byId("native-inputs"), "run"))], {
    cwd: root, env: { ...process.env, ...environment, GITHUB_OUTPUT: output, PATH: `${root}/bin:${process.env.PATH}` }, encoding: "utf8", timeout: 3000,
  });
  return { status: result.status, output: readFileSync(output, "utf8") };
}

function nativeRestorePrefixes(output: string): string[] {
  const hash = /^hash=([a-f0-9]{64})\n$/.exec(output)?.[1];
  if (!hash) throw new Error("Missing effective native fingerprint");
  return ["native-cargo-cache", "native-cache"].map(id => {
    const template = string(field(field(byId(id), "with"), "restore-keys"));
    expect(template).toContain("${{ steps.native-inputs.outputs.hash }}");
    return template.replaceAll("${{ steps.native-inputs.outputs.hash }}", hash);
  });
}

function expectNativeRestoreMiss(before: string, after: string) {
  const prefixes = nativeRestorePrefixes(before);
  for (const [index, prefix] of nativeRestorePrefixes(after).entries()) expect(prefix).not.toBe(prefixes[index]);
}

test("extracted native input shell rejects failed probes and keys effective flags, not raw env bytes", () => {
  shellFixture(root => {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "env.sh"), `export BUN_WASM_SYSROOT=${root}\n`);
    writeFileSync(join(root, "bun-wasm-sysroot.json"), '{"verified":"sysroot"}');
    for (const tool of ["cc", "c++", "rustc", "cargo", "cmake", "ninja"]) {
      writeFileSync(join(root, "bin", tool), `#!/bin/bash\n[[ "\${FAIL_TOOL:-}" != "${tool}" ]] || exit 42\necho "fixture ${tool} \${PROBE_VERSION:-1}"\n`, { mode: 0o755 });
    }
    const before = nativeFingerprint(root);
    expect(before.status).toBe(0);
    expect(before.output).toMatch(/^hash=[a-f0-9]{64}\n$/);
    writeFileSync(join(root, "env.sh"), `# Unrelated scratch policy\nexport BUN_WASM_SYSROOT=${root}\n`);
    expect(nativeFingerprint(root)).toEqual(before);
    for (const variable of ["CC", "CXX", "AR", "RANLIB", "LD", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "SDKROOT", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS"]) {
      const changed = nativeFingerprint(root, { [variable]: variable === "CC" ? "cc --compiler-identity" : variable === "CXX" ? "c++ --compiler-identity" : "changed" });
      expect(changed.status).toBe(0);
      expect(changed.output).not.toBe(before.output);
    }
    const changedTools = nativeFingerprint(root, { PROBE_VERSION: "changed" });
    expect(changedTools.output).not.toBe(before.output);
    expectNativeRestoreMiss(before.output, changedTools.output);
    writeFileSync(join(root, "bun-wasm-sysroot.json"), '{"verified":"changed SDK/sysroot ABI"}');
    const changedReceipt = nativeFingerprint(root);
    expect(changedReceipt.output).not.toBe(before.output);
    expectNativeRestoreMiss(before.output, changedReceipt.output);
    writeFileSync(join(root, "bun-wasm-sysroot.json"), '{"verified":"sysroot"}');
    for (const tool of ["cc", "c++", "rustc", "cargo", "cmake", "ninja"]) {
      expect(nativeFingerprint(root, { FAIL_TOOL: tool })).toEqual({ status: 1, output: "" });
    }
    rmSync(join(root, "bun-wasm-sysroot.json"));
    expect(nativeFingerprint(root)).toEqual({ status: 1, output: "" });
  });
});

const producerBoundaries = [
  ["Build or verify the JSC prebuild", "run_jsc_prebuild"],
  ["Save the JSC prebuild cache once per input revision", "jsc"],
  ["Package the verified prebuild and sysroot", ""],
] satisfies [string, string][];

const checkpointBoundaries = [
  ["Import the verified JSC prebuild and sysroot", ""],
  ["Blocking native quality checks", "run_native_checks"],
  ["Save the native quality checkpoint", "native"],
  ["Start the JSC Cargo guest build", ""],
  ["Build native fixtures after the cache checkpoint", ""],
  ["Build the JSC Cargo guest", ""],
  ["Save the JSC Cargo cache once per input revision", "jsc-cargo"],
  ["Blocking JSC embedding and allocation checks", ""],
  ["Blocking native fixture checks", ""],
  ["Build the single tools fixture in the existing native target", ""],
  ["Save the refined native Cargo cache once per input revision", "native-final"],
  ["Blocking Web guest cases (QuickJS and host engine)", ""],
] satisfies [string, string][];

function boundaryCommands(failure: string, cancelled: boolean, controller = true, boundaries: readonly (readonly [string, string])[] = checkpointBoundaries, list: readonly unknown[] = stepList): string {
  const ordered = boundaries.toSorted((left, right) => position(left[0], list) - position(right[0], list));
  expect<readonly (readonly [string, string])[]>(ordered).toEqual(boundaries);
  return ordered.map(([name, marker]) => {
    const item = named(name, list);
    if (name.startsWith("Save ")) {
      expect(field(item, "uses")).toBe("actions/cache/save@v4");
      return `printf '%s\\n' '${marker}' >> "$CHECKPOINT_RECORDS"`;
    }
    const signal = controller ? 'kill -TERM "$$"; sleep 30' : 'kill -TERM "$BASHPID"';
    const body = name === failure ? cancelled ? signal : "exit 42" : "true";
    const original = string(field(item, "run"));
    const script = marker ? original.replace(new RegExp(`^${marker}\\(\\) {\\n[^]*?^}`, "m"), () => `${marker}() {\n  ${body}\n}`) : body;
    return `bash -eo pipefail -c '${script.replaceAll("'", "'\\''")}'`;
  }).join("\n");
}

for (const [failure, expected] of [
  ["Build or verify the JSC prebuild", []],
  ["Package the verified prebuild and sysroot", ["jsc"]],
] satisfies [string, string[]][]) {
  test(`extracted prebuild job retains earlier checkpoint records when ${failure} fails or is cancelled`, () => {
    shellFixture(root => assertCheckpointRecords(root, failure, expected, producerBoundaries, producerSteps));
  });
}

for (const [failure, expected] of [
  ["Import the verified JSC prebuild and sysroot", []],
  ["Blocking native quality checks", []],
  ["Build native fixtures after the cache checkpoint", ["native"]],
  ["Build the JSC Cargo guest", ["native"]],
  ["Blocking JSC embedding and allocation checks", ["native", "jsc-cargo"]],
  ["Blocking native fixture checks", ["native", "jsc-cargo"]],
  ["Build the single tools fixture in the existing native target", ["native", "jsc-cargo"]],
  ["Blocking Web guest cases (QuickJS and host engine)", ["native", "jsc-cargo", "native-final"]],
] satisfies [string, string[]][]) {
  test(`extracted workflow retains earlier checkpoint records when ${failure} fails or is cancelled`, () => {
    shellFixture(root => assertCheckpointRecords(root, failure, expected));
  });
}

function assertCheckpointRecords(root: string, failure: string, expected: readonly string[], boundaries: readonly (readonly [string, string])[] = checkpointBoundaries, list: readonly unknown[] = stepList) {
  for (const cancelled of [false, true]) {
    const records = join(root, "checkpoint-records");
    writeFileSync(records, "");
    const output = join(root, "outputs");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", boundaryCommands(failure, cancelled, true, boundaries, list)], {
      env: { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, CHECKPOINT_RECORDS: records }, timeout: 3000,
    });
    expect(result.signal === "SIGTERM" ? 143 : result.status).toBe(cancelled ? 143 : 42);
    expect<readonly string[]>(readFileSync(records, "utf8").trim().split("\n").filter(Boolean)).toEqual(expected);
    const completions = ["jsc", "native"].filter(producer => expected.includes(producer)).map(producer => `${producer}-ready=true\n`).join("");
    expect(readFileSync(output, "utf8")).toBe(completions);
    expect(readdirSync(root).filter(name => name.startsWith("jsc-completion-"))).toEqual([]);
  }
}

for (const ignoreWaitFailure of [false, true]) test(`terminated JSC worker cannot advertise completion with ${ignoreWaitFailure ? "forced-success" : "native"} wait`, () => {
  shellFixture(root => {
    const output = join(root, "outputs"), records = join(root, "checkpoints");
    writeFileSync(output, "");
    writeFileSync(records, "");
    const original = boundaryCommands("Build or verify the JSC prebuild", true, false, producerBoundaries, producerSteps);
    const script = ignoreWaitFailure ? original.replace('wait "$jsc_pid"\n', 'wait "$jsc_pid" || true\n') : original;
    expect(script === original).toBe(!ignoreWaitFailure);
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
      env: { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, CHECKPOINT_RECORDS: records }, timeout: 3000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe("");
    expect(readFileSync(records, "utf8")).toBe("");
    expect(readdirSync(root).filter(name => name.startsWith("jsc-completion-"))).toEqual([]);
  });
});
