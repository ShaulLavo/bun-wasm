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
const steps: unknown = field(field(field(workflow, "jobs"), "rust"), "steps");
if (!Array.isArray(steps)) throw new Error("Expected workflow steps");
const stepList: unknown[] = steps;
function step(key: string, value: string): unknown {
  const found = stepList.filter(item => typeof item === "object" && item !== null && key in item && Reflect.get(item, key) === value);
  expect(found).toHaveLength(1);
  return found[0];
}
const byId = (id: string) => step("id", id);
const named = (name: string) => step("name", name);
const position = (name: string) => stepList.indexOf(named(name));

test("sysroot and prebuild restores use effective inputs and have bounded compatible fallbacks", () => {
  for (const id of ["sysroot-cache", "jsc-prebuild-cache", "jsc-cargo-cache"]) {
    const restore = field(byId(id), "with");
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
  expect(field(field(field(workflow, "jobs"), "rust"), "if")).toBe("needs.quality.outputs.rust == 'true'");
  for (const prerequisite of [named("Configure private JSC build paths"), byId("jsc-inputs"), byId("jsc-prebuild-cache"), named("Start the JSC prebuild beside native quality")]) {
    expect(prerequisite).not.toHaveProperty("if");
  }
  expect(string(field(byId("jsc-producer"), "if"))).not.toContain("needs.quality.outputs.jsc");
  const tools = named("Build the single tools fixture in the existing native target");
  expect(tools).not.toHaveProperty("if");
  expect(position("Start the JSC prebuild beside native quality")).toBeLessThan(position("Blocking native quality checks"));
  expect(position("Build or verify the JSC prebuild")).toBeLessThan(stepList.indexOf(tools));
  expect(position("Save the JSC prebuild cache once per input revision")).toBeLessThan(stepList.indexOf(tools));
  for (const engine of [byId("jsc-cargo-cache"), named("Build the JSC Cargo guest"), named("Blocking JSC embedding and allocation checks"), named("Blocking Web guest case (JSC)")]) {
    expect(field(engine, "if")).toBe("needs.quality.outputs.jsc == 'true'");
  }
});

test("completed caches are saved before later validation can fail or time out", () => {
  expect(position("Save the verified sysroot cache")).toBeGreaterThan(position("Build patched WASI sysroot"));
  expect(position("Save the verified sysroot cache")).toBeLessThan(position("Blocking native quality checks"));
  expect(position("Save the JSC prebuild cache once per input revision")).toBeLessThan(position("Blocking JSC embedding and allocation checks"));
  expect(position("Save the JSC Cargo cache once per input revision")).toBeLessThan(position("Blocking JSC embedding and allocation checks"));
  expect(position("Save the native quality checkpoint")).toBeLessThan(position("Build native fixtures after the cache checkpoint"));
  expect(position("Save the refined native Cargo cache once per input revision")).toBeLessThan(position("Blocking Web guest cases (QuickJS and host engine)"));
  expect(field(named("Save the JSC prebuild cache once per input revision"), "if")).toContain("!cancelled()");
  expect(field(named("Save the JSC prebuild cache once per input revision"), "if")).toContain("outputs.jsc-ready == 'true'");
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
  for (const [id, producer] of [
    ["rustup-cache", "dtolnay/rust-toolchain@nightly"], ["sdk", "Install pinned WASI SDK"],
    ["binaryen-cache", "Install pinned Binaryen"], ["wasmtime-cache", "Install pinned Wasmtime"], ["sources-cache", "Prepare pinned upstream sources"],
  ] satisfies [string, string][]) {
    const restore = byId(id);
    const output = named(`Save completed ${id} setup`);
    const build = step(id === "rustup-cache" ? "uses" : "name", producer);
    expect(stepList.indexOf(output)).toBe(stepList.indexOf(build) + 1);
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
  shellFixture(root => assertProducerCompletion(root, "Blocking native quality checks", "run_native_checks", "native-ready"));
});

function assertProducerCompletion(root: string, name: string, functionName: string, outputName: string) {
  const original = string(field(named(name), "run"));
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

const checkpointBoundaries = [
  ["Start the JSC prebuild beside native quality", "run_jsc_prebuild"],
  ["Blocking native quality checks", "run_native_checks"],
  ["Save the native quality checkpoint", "native"],
  ["Build or verify the JSC prebuild", ""],
  ["Save the JSC prebuild cache once per input revision", "jsc"],
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

// Models a main push: a failed step skips default-gated steps, while steps whose condition
// survives failure still run. A cancellation (143) stops the controller.
function afterFailure(item: unknown): string {
  const condition = typeof item === "object" && item !== null && "if" in item ? string(field(item, "if")) : "";
  if (!condition.includes("!cancelled()")) return "false";
  if (condition.includes("(success() || (github.event_name == 'push' && github.ref == 'refs/heads/main'))")) return "true";
  const ready = /steps\.[\w-]+\.outputs\.([\w-]+-ready) == 'true'/.exec(condition)?.[1];
  return ready ? `grep -qx '${ready}=true' "$GITHUB_OUTPUT"` : "false";
}

function boundaryCommands(failure: string, cancelled: boolean): string {
  const ordered = checkpointBoundaries.toSorted((left, right) => position(left[0]) - position(right[0]));
  expect(ordered).toEqual(checkpointBoundaries);
  return ordered.map(([name, marker]) => {
    const item = named(name);
    let command: string;
    if (name.startsWith("Save ")) {
      expect(field(item, "uses")).toBe("actions/cache/save@v4");
      command = `printf '%s\\n' '${marker}' >> "$CHECKPOINT_RECORDS"`;
    } else {
      const body = name === failure ? cancelled ? 'kill -TERM "$$"; sleep 30' : "exit 42" : "true";
      const original = string(field(item, "run"));
      // The real wait runs against the real background launch with a stubbed workload.
      const real = name === "Build or verify the JSC prebuild" && name !== failure;
      const script = real ? original : marker ? original.replace(new RegExp(`^${marker}\\(\\) {\\n[^]*?^}`, "m"), () => `${marker}() {\n  ${body}\n}`) : body;
      command = `bash -eo pipefail -c '${script.replaceAll("'", "'\\''")}'`;
    }
    return `if [[ -z "$failed" ]] || ${afterFailure(item)}; then ${command} || { status=$?; [[ $status != 143 ]] || exit 143; failed=\${failed:-$status}; }; fi`;
  }).join("\n").replace(/^/, "failed=\n").concat('\nexit "${failed:-0}"');
}

for (const [failure, failed, cancelled] of [
  ["Build or verify the JSC prebuild", ["native"], ["native"]],
  ["Blocking native quality checks", ["jsc"], []],
  ["Build native fixtures after the cache checkpoint", ["native", "jsc"], ["native", "jsc"]],
  ["Build the JSC Cargo guest", ["native", "jsc"], ["native", "jsc"]],
  ["Blocking JSC embedding and allocation checks", ["native", "jsc", "jsc-cargo"], ["native", "jsc", "jsc-cargo"]],
  ["Blocking native fixture checks", ["native", "jsc", "jsc-cargo"], ["native", "jsc", "jsc-cargo"]],
  ["Build the single tools fixture in the existing native target", ["native", "jsc", "jsc-cargo"], ["native", "jsc", "jsc-cargo"]],
  ["Blocking Web guest cases (QuickJS and host engine)", ["native", "jsc", "jsc-cargo", "native-final"], ["native", "jsc", "jsc-cargo", "native-final"]],
] satisfies [string, string[], string[]][]) {
  test(`extracted workflow retains completed checkpoint records when ${failure} fails or is cancelled`, () => {
    shellFixture(root => {
      assertCheckpointRecords(root, failure, false, failed);
      assertCheckpointRecords(root, failure, true, cancelled);
    });
  });
}

function assertCheckpointRecords(root: string, failure: string, cancelled: boolean, expected: readonly string[]) {
  rmSync(join(root, "jsc-prebuild"), { recursive: true, force: true });
  const records = join(root, "checkpoint-records");
  writeFileSync(records, "");
  const output = join(root, "outputs");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-o", "pipefail", "-c", boundaryCommands(failure, cancelled)], {
    env: { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, CHECKPOINT_RECORDS: records }, timeout: 10000,
  });
  expect(result.signal === "SIGTERM" ? 143 : result.status).toBe(cancelled ? 143 : 42);
  expect<readonly string[]>(readFileSync(records, "utf8").trim().split("\n").filter(Boolean)).toEqual(expected);
  const completions = ["native", "jsc"].filter(producer => expected.includes(producer)).map(producer => `${producer}-ready=true\n`).join("");
  expect(readFileSync(output, "utf8")).toBe(completions);
  expect(readdirSync(join(root, "jsc-prebuild"))).toContain("pid");
}
