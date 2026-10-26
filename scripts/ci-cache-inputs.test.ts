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
  for (const path of ["scripts/guest-source-manifest.ts", "crates/bunwasm-runtime/src/engine_quickjs.rs", "web/guest-tests/quickjs.test.ts"]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(false);
  }
  expect(field(field(field(workflow, "jobs"), "rust"), "if")).toBe("needs.quality.outputs.rust == 'true'");
  for (const prerequisite of [named("Configure private JSC build paths"), byId("jsc-inputs"), byId("jsc-prebuild-cache"), byId("jsc-producer")]) {
    expect(prerequisite).not.toHaveProperty("if");
  }
  const tools = named("Build the single tools fixture in the existing native target");
  expect(tools).not.toHaveProperty("if");
  expect(position("Build or verify the JSC prebuild")).toBeLessThan(stepList.indexOf(tools));
  expect(position("Save the JSC prebuild cache once per input revision")).toBeLessThan(position("Blocking native quality checks"));
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

test("each setup cache has one immediate save after its successful producer", () => {
  for (const [id, producer] of [
    ["rustup-cache", "dtolnay/rust-toolchain@nightly"], ["sdk", "Install pinned WASI SDK"],
    ["binaryen-cache", "Install pinned Binaryen"], ["sources-cache", "Prepare pinned upstream sources"],
  ] satisfies [string, string][]) {
    const restore = byId(id);
    const output = named(`Save completed ${id} setup`);
    const build = step(id === "rustup-cache" ? "uses" : "name", producer);
    expect(stepList.indexOf(output)).toBe(stepList.indexOf(build) + 1);
    expect(field(output, "if")).toBe(`steps.${id}.outputs.cache-hit != 'true'`);
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
    for (const [name, functionName, outputName] of [
      ["Build or verify the JSC prebuild", "run_jsc_prebuild", "jsc-ready"],
      ["Blocking native quality checks", "run_native_checks", "native-ready"],
    ] satisfies [string, string, string][]) {
      assertProducerCompletion(root, name, functionName, outputName);
    }
  });
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

test("extracted native input shell rejects failed probes and keys effective flags, not raw env bytes", () => {
  shellFixture(root => {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "env.sh"), `export BUN_WASM_SYSROOT=${root}\n`);
    writeFileSync(join(root, "bun-wasm-sysroot.json"), '{"verified":"sysroot"}');
    for (const tool of ["cc", "c++", "rustc", "cargo", "cmake", "ninja"]) {
      writeFileSync(join(root, "bin", tool), `#!/bin/bash\n[[ "\${FAIL_TOOL:-}" != "${tool}" ]] || exit 42\necho 'fixture ${tool} 1'\n`, { mode: 0o755 });
    }
    const before = nativeFingerprint(root);
    expect(before.status).toBe(0);
    expect(before.output).toMatch(/^hash=[a-f0-9]{64}\n$/);
    writeFileSync(join(root, "env.sh"), `# Unrelated scratch policy\nexport BUN_WASM_SYSROOT=${root}\n`);
    expect(nativeFingerprint(root)).toEqual(before);
    expect(nativeFingerprint(root, { CFLAGS: "-DCHANGED=1" }).output).not.toBe(before.output);
    for (const tool of ["cc", "c++", "rustc", "cargo", "cmake", "ninja"]) {
      expect(nativeFingerprint(root, { FAIL_TOOL: tool })).toEqual({ status: 1, output: "" });
    }
    rmSync(join(root, "bun-wasm-sysroot.json"));
    expect(nativeFingerprint(root)).toEqual({ status: 1, output: "" });
  });
});

const checkpointBoundaries = [
  ["Build or verify the JSC prebuild", "run_jsc_prebuild"],
  ["Save the JSC prebuild cache once per input revision", "jsc"],
  ["Blocking native quality checks", "run_native_checks"],
  ["Save the native quality checkpoint", "native"],
  ["Build native fixtures after the cache checkpoint", ""],
  ["Build the JSC Cargo guest", ""],
  ["Save the JSC Cargo cache once per input revision", "jsc-cargo"],
  ["Blocking JSC embedding and allocation checks", ""],
  ["Build the single tools fixture in the existing native target", ""],
  ["Save the refined native Cargo cache once per input revision", "native-final"],
  ["Blocking Web guest cases (QuickJS and host engine)", ""],
] satisfies [string, string][];

function boundaryCommands(failure: string, cancelled: boolean, controller = true): string {
  const ordered = checkpointBoundaries.toSorted((left, right) => position(left[0]) - position(right[0]));
  expect(ordered).toEqual(checkpointBoundaries);
  return ordered.map(([name, marker]) => {
    const item = named(name);
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
  ["Blocking native quality checks", ["jsc"]],
  ["Build native fixtures after the cache checkpoint", ["jsc", "native"]],
  ["Build the JSC Cargo guest", ["jsc", "native"]],
  ["Blocking JSC embedding and allocation checks", ["jsc", "native", "jsc-cargo"]],
  ["Build the single tools fixture in the existing native target", ["jsc", "native", "jsc-cargo"]],
  ["Blocking Web guest cases (QuickJS and host engine)", ["jsc", "native", "jsc-cargo", "native-final"]],
] satisfies [string, string[]][]) {
  test(`extracted workflow retains earlier checkpoint records when ${failure} fails or is cancelled`, () => {
    shellFixture(root => assertCheckpointRecords(root, failure, expected));
  });
}

function assertCheckpointRecords(root: string, failure: string, expected: readonly string[]) {
  for (const cancelled of [false, true]) {
    const records = join(root, "checkpoint-records");
    writeFileSync(records, "");
    const output = join(root, "outputs");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", boundaryCommands(failure, cancelled)], {
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
    const original = boundaryCommands("Build or verify the JSC prebuild", true, false);
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
