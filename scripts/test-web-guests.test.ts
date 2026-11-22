import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";
import { prepareWebGuestFixtures, webGuestArtifacts, webGuestEngines } from "./test-web-guests";

const workflow = expandedCiWorkflow();
const ordinaryBuild = workflow.split("\n  ordinary-build:\n")[1]!.split("\n  shared-sysroot:\n")[0]!;
const shared = workflow.split("\n  shared-sysroot:\n")[1]!.split("\n  rust:\n")[0]!;
const rust = workflow.split("\n  rust:\n")[1]!.split("\n  rust-fixtures:\n")[0]!;
const web = workflow.split("\n  web-unit:\n")[1]!.split("\n  web-browser:\n")[0]!;

test("guest groups are explicit, nonempty, unique and reject typos", () => {
  expect(Array.from(webGuestEngines(["quickjs", "browser", "jsc"]), engine => webGuestArtifacts[engine])).toEqual(Object.values(webGuestArtifacts));
  for (const args of [[], ["all"], ["quickjs", "quickjs"], ["jcs"]]) {
    expect(() => webGuestEngines(args)).toThrow();
  }
});

for (const engine of webGuestEngines(["quickjs", "browser", "jsc"])) {
  test(`${engine} fixture preparation rejects absent guests, receipts and malformed receipts`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-guest-preparation-"));
    try {
      mkdirSync(join(directory, "dist"));
      const path = join(directory, "dist", webGuestArtifacts[engine]);
      await expect(prepareWebGuestFixtures(directory, engine)).rejects.toThrow(`Missing required Web guest fixture: ${path}`);
      writeFileSync(path, "not a guest");
      await expect(prepareWebGuestFixtures(directory, engine)).rejects.toThrow(`Missing required Web guest receipt: ${path}.build.json`);
      writeFileSync(`${path}.build.json`, "{}");
      await expect(prepareWebGuestFixtures(directory, engine)).rejects.toThrow("Invalid guest build receipt");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("preparation rejects missing tools and mismatched or corrupted receipt bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-guest-receipts-"));
  try {
    mkdirSync(join(directory, "dist"));
    const { core: bytes, side } = quickjsPair();
    const receipt = fixtureReceipt(bytes, "quickjs", side);
    const guest = join(directory, "dist/bun.wasm");
    writeFileSync(guest, bytes);
    writeFileSync(join(directory, "dist/quickjs.wasm"), side);
    writeFileSync(`${guest}.build.json`, JSON.stringify(receipt));
    await expect(prepareWebGuestFixtures(directory, "quickjs")).rejects.toThrow("dist/bun-tools.wasm");
    const tools = join(directory, "dist/bun-tools.wasm");
    writeFileSync(tools, wasm);
    writeFileSync(`${tools}.build.json`, JSON.stringify({ ...fixtureReceipt(wasm, "tools"), bunTree: "d".repeat(40) }));
    await expect(prepareWebGuestFixtures(directory, "quickjs")).rejects.toThrow("fixture mismatch: bunTree");
    writeFileSync(tools, "corrupted receipt fixture");
    await expect(prepareWebGuestFixtures(directory, "quickjs")).rejects.toThrow("does not match artifact bytes");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("all artifact-backed cases leave the fixture-free Web glob", () => {
  const node = readFileSync(new URL("../web/tests/node-process.test.ts", import.meta.url), "utf8");
  const net = readFileSync(new URL("../web/tests/net.test.ts", import.meta.url), "utf8");
  expect(node).not.toContain("skipIf");
  expect(node).not.toContain("fetch compose");
  expect(net).not.toContain("installHostSlots fills");
  const quickjs = readFileSync(new URL("../web/guest-tests/quickjs.test.ts", import.meta.url), "utf8");
  const browser = readFileSync(new URL("../web/guest-tests/browser.test.ts", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../web/guest-tests/compose.ts", import.meta.url), "utf8");
  expect(quickjs.match(/test\(/g)).toHaveLength(2);
  expect(quickjs).toContain("for (const fallback of [false, true])");
  expect(browser.match(/test\(/g)).toHaveLength(5);
  expect(compose).not.toContain("skipIf");
  expect(compose).toContain("child lint routed");
  expect(compose).toContain('INSTALL_CASES: "aliases"');
  expect(web).toContain("test-web-host.sh --unit");
  expect(web).not.toContain("test-web-guests.ts");
});

function nativeStepNames(id = "rust"): string[] {
  const parsed: unknown = Bun.YAML.parse(workflow);
  if (typeof parsed !== "object" || parsed === null || !("jobs" in parsed)) throw new Error("Missing workflow jobs");
  const jobs: unknown = parsed.jobs;
  if (typeof jobs !== "object" || jobs === null || !(id in jobs)) throw new Error(`Missing ${id} job`);
  const job: unknown = Reflect.get(jobs, id);
  if (typeof job !== "object" || job === null || !("steps" in job) || !Array.isArray(job.steps)) throw new Error("Missing native steps");
  return job.steps.map((step: unknown) => {
    if (typeof step !== "object" || step === null || !("name" in step) || typeof step.name !== "string") return "";
    return step.name;
  });
}

test("the existing native producer owns each guest build once and runs guest cases after checkpoints", () => {
  const buildNames = nativeStepNames("ordinary-build");
  const qualityNames = nativeStepNames("native-quality");
  const runtimeNames = nativeStepNames("rust");
  expect(buildNames.filter(value => value === "Build the single tools fixture in the existing native target")).toHaveLength(1);
  expect(buildNames.filter(value => value === "Save the JSC Cargo cache once per input revision")).toHaveLength(1);
  expect(buildNames.filter(value => value === "Save the refined native Cargo cache once per input revision")).toHaveLength(1);
  expect(qualityNames.filter(value => value === "Save the native quality checkpoint")).toHaveLength(1);
  expect(buildNames.indexOf("Save the refined native Cargo cache once per input revision")).toBeGreaterThan(buildNames.indexOf("Build the single tools fixture in the existing native target"));
  for (const name of ["Blocking Web guest cases (QuickJS and host engine)", "Blocking Web guest case (JSC)"]) {
    expect(runtimeNames.filter(value => value === name)).toHaveLength(1);
  }
  expect(rust.split("test-web-guests.ts quickjs browser")).toHaveLength(2);
  expect(rust.split("test-web-guests.ts jsc")).toHaveLength(2);
  expect(ordinaryBuild.split("bash scripts/build-bun-tools.sh")).toHaveLength(2);
  expect(ordinaryBuild).toContain('TOOLS_CARGO_TARGET_DIR="$CARGO_TARGET_DIR" JOBS=4');
  expect(ordinaryBuild.split("CARGO_BUILD_JOBS=3 bash scripts/build.sh")).toHaveLength(2);
  const wrapper = readFileSync(new URL("./build.sh", import.meta.url), "utf8");
  expect(wrapper).toContain('guest-build-receipt.ts" write "$root/dist/bun.wasm" "$guest_inputs"');
  expect(ordinaryBuild).toContain('BROWSER_CARGO_TARGET_DIR="$CARGO_TARGET_DIR" JOBS=3 bash scripts/build-bun-browser.sh');
  expect(ordinaryBuild).not.toContain("ln -s source-cache-browser");
  expect(ordinaryBuild).toContain("name: web-guest-fixture-receipts");
  expect(ordinaryBuild).toContain("if-no-files-found: error");
  expect(ordinaryBuild).not.toContain("continue-on-error");
  expect(ordinaryBuild.indexOf("bun scripts/ci-binaryen.ts")).toBeLessThan(ordinaryBuild.indexOf("bash scripts/build-bun-tools.sh"));
});

test("guest gate logs retain stderr and cannot hide failure behind tee", () => {
  expect(rust).toContain("shell: setpriv --inh-caps=-all --ambient-caps=-all bash --noprofile --norc -e -o pipefail {0}");
  const steps = rust.split("      - name: Blocking Web guest ").slice(1);
  expect(steps).toHaveLength(2);
  for (const step of steps) {
    const gate = step.split("      - ")[0]!;
    expect(gate).toContain("2>&1 | tee dist/web-guests-");
  }
});

for (const path of [
  "web/scripts/node-spawn.ts", "web/scripts/node-host.mjs", "web/scripts/node-worker.ts", "web/scripts/node-process.ts", "web/src/net/trampoline.ts",
  "web/src/engine-host.js", "web/src/host-crypto.ts", "web/bun.lock", "web/guest-tests/compose.ts",
  "web/tests/subprocess.ts", "tests/fixtures/spawn-executable/index.ts", "tests/install/run.mjs",
  "crates/bunwasm-runtime/src/host.rs", "crates/bunwasm-runtime/src/js/process.ts", "crates/bunwasm-cli/src/main.rs",
  "scripts/test-web-guests.ts", "scripts/guest-build-receipt.ts", "scripts/build-bun-tools.sh",
  "scripts/sync-bun.sh", "scripts/sync-crypto.sh", "tests/fixtures/runtime-proc-spawn-requests.json",
]) {
  test(`${path} selects all real guest gates for a shared contract`, () => {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(true);
  });
}

for (const path of ["web/src/main.ts", "web/src/editor.ts", "site/src/main.ts", "docs/code-quality.md"]) {
  test(`${path} does not compile engines for a UI or documentation change`, () => {
    expect(needsRust([path])).toBe(false);
    expect(needsJsc([path])).toBe(false);
  });
}

test("sandbox page selects its registered Browser guest producer", () => {
  expect(needsRust(["sandbox/src/main.ts"])).toBe(true);
  expect(needsJsc(["sandbox/src/main.ts"])).toBe(false);
});

test("engine-specific changes keep their own native gates", () => {
  expect(needsJsc(["crates/bunwasm-runtime/src/engine_quickjs.rs"])).toBe(false);
  expect(needsJsc(["crates/bunwasm-runtime/src/engine_host.rs"])).toBe(false);
  expect(needsRust(["crates/bunwasm-runtime/src/engine_quickjs.rs"])).toBe(true);
  expect(needsJsc(["crates/bunwasm-runtime/src/engine_jsc.rs"])).toBe(true);
  for (const path of ["web/guest-tests/quickjs.test.ts", "web/guest-tests/browser.test.ts"]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(false);
  }
  expect(needsJsc(["web/guest-tests/jsc.test.ts"])).toBe(true);
  for (const path of ["tests/async-context-runtime/prepare-probe.ts", "tests/async-context-rejection/index.ts", "web/src/script-evaluation.ts"]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(false);
  }
});

test("ordinary-build saves its JSC prebuild cache before building guests and exporting receipts", () => {
  const producer = nativeStepNames("ordinary-build");
  const owner = "Build or verify the JSC prebuild";
  expect(producer.filter(value => value === owner)).toHaveLength(1);
  expect(producer.indexOf("Save the JSC prebuild cache once per input revision")).toBe(producer.indexOf(owner) + 1);
  for (const step of ["Build the standard Browser guest once", "Build the single tools fixture in the existing native target", "Save the JSC Cargo cache once per input revision", "Save the refined native Cargo cache once per input revision"]) {
    expect(producer.filter(value => value === step)).toHaveLength(1);
    expect(producer.indexOf(step)).toBeGreaterThan(producer.indexOf(owner));
  }
  expect(ordinaryBuild.match(/bash scripts\/build-jsc\.sh/g)).toHaveLength(1);
  expect(shared.match(/bash scripts\/build-jsc\.sh/g)).toHaveLength(1);
  expect(shared).toContain("JSC_PROFILE: shared-group");
  expect(workflow.match(/bash scripts\/build-jsc\.sh/g)).toHaveLength(2);
  expect(ordinaryBuild.match(/bash scripts\/build-bun-jsc.sh/g)).toHaveLength(1);
  const script = ordinaryBuild.split(`      - name: ${owner}\n`)[1]!.split("      - name: Save the JSC prebuild cache")[0]!;
  expect(script).toContain('wait "$jsc_pid"\n          [[ "$(cat "$jsc_completion")" == verified ]]\n          echo "jsc-ready=true" >> "$GITHUB_OUTPUT"');
  expect(script).not.toContain("continue-on-error");
  expect(script).not.toContain("uses: actions/cache/save");
  expect(ordinaryBuild).toContain("dist/web-guests-*.log\n            ${{ runner.temp }}/jsc-prebuild.log");
  expect(ordinaryBuild).toContain("dist/*.wasm.embedding.json");
  expect(ordinaryBuild).toContain("${{ runner.temp }}/jsc/engine/engine-link.map");
  expect(ordinaryBuild).not.toContain("name: jsc-embedding-receipts");
  expect(ordinaryBuild).toContain("if: always()\n        with:\n          name: web-guest-fixture-receipts");
});

test("fixture preflight rejects a valid receipt for the wrong requested primary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-wrong-engine-"));
  try {
    mkdirSync(join(directory, "dist"));
    const { core, side } = quickjsPair();
    const path = join(directory, "dist/bun-browser.wasm");
    writeFileSync(path, core);
    writeFileSync(join(directory, "dist/quickjs.wasm"), side);
    writeFileSync(`${path}.build.json`, JSON.stringify(fixtureReceipt(core, "quickjs", side)));
    await expect(prepareWebGuestFixtures(directory, "browser")).rejects.toThrow("Web guest engine mismatch");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
