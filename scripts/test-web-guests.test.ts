import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";
import { prepareWebGuestFixtures, webGuestArtifacts, webGuestEngines } from "./test-web-guests";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const rust = workflow.split("\n  rust:\n")[1]!.split("\n  package:\n")[0]!;
const web = workflow.split("\n  web:\n")[1]!.split("\n  process-bundles:\n")[0]!;

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

test("all eight artifact-backed cases leave the fixture-free Web glob", () => {
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
  expect(browser.match(/test\(/g)).toHaveLength(3);
  expect(compose).not.toContain("skipIf");
  expect(compose).toContain("child lint routed");
  expect(compose).toContain('INSTALL_CASES: "aliases"');
  expect(web).toContain("test-web-host.sh --unit");
  expect(web).not.toContain("test-web-guests.ts");
});

function nativeStepNames(): string[] {
  const parsed: unknown = Bun.YAML.parse(workflow);
  if (typeof parsed !== "object" || parsed === null || !("jobs" in parsed)) throw new Error("Missing workflow jobs");
  const jobs = parsed.jobs;
  if (typeof jobs !== "object" || jobs === null || !("rust" in jobs)) throw new Error("Missing native job");
  const job = jobs.rust;
  if (typeof job !== "object" || job === null || !("steps" in job) || !Array.isArray(job.steps)) throw new Error("Missing native steps");
  return job.steps.map((step: unknown) => {
    if (typeof step !== "object" || step === null || !("name" in step) || typeof step.name !== "string") return "";
    return step.name;
  });
}

test("the existing native producer owns each guest group once, after completed cache checkpoints", () => {
  const names = nativeStepNames();
  const consumers = ["Build the single tools fixture in the existing native target", "Blocking Web guest cases (QuickJS and host engine)", "Blocking Web guest case (JSC)"];
  const saves = ["Save the JSC prebuild cache once per input revision", "Save the JSC Cargo cache once per input revision", "Save the refined native Cargo cache once per input revision", "Save the native quality checkpoint"];
  for (const name of consumers.concat(saves)) expect(names.filter(value => value === name)).toHaveLength(1);
  for (const save of saves) {
    for (const consumer of consumers.slice(1)) expect(names.indexOf(save)).toBeLessThan(names.indexOf(consumer));
  }
  expect(names.indexOf(saves[2]!)).toBeGreaterThan(names.indexOf(consumers[0]!));
  for (const command of ["test-web-guests.ts quickjs browser", "test-web-guests.ts jsc", "bash scripts/build-bun-tools.sh"]) {
    expect(workflow.split(command)).toHaveLength(2);
    expect(rust.indexOf(command)).toBeGreaterThan(0);
  }
  expect(rust).toContain('TOOLS_CARGO_TARGET_DIR="$CARGO_TARGET_DIR" JOBS=2');
  expect(rust.split("CARGO_BUILD_JOBS=2 bash scripts/build.sh")).toHaveLength(2);
  const wrapper = readFileSync(new URL("./build.sh", import.meta.url), "utf8");
  expect(wrapper).toContain('guest-build-receipt.ts" write "$root/dist/bun.wasm" "$guest_inputs"');
  expect(rust).toContain("ln -s source-cache-browser/bun-browser.wasm dist/bun-browser.wasm");
  expect(rust).toContain("ln -s source-cache-browser/bun-browser.wasm.build.json dist/bun-browser.wasm.build.json");
  expect(rust).toContain("name: web-guest-fixture-receipts");
  expect(rust).toContain("if-no-files-found: error");
  expect(rust).not.toContain("continue-on-error");
  expect(rust.indexOf("bun scripts/ci-binaryen.ts")).toBeLessThan(rust.indexOf("bash scripts/build-bun-tools.sh"));
});

test("guest gate logs retain stderr and cannot hide failure behind tee", () => {
  const steps = rust.split("      - name: Blocking Web guest ").slice(1);
  expect(steps).toHaveLength(2);
  for (const step of steps) {
    const gate = step.split("      - ")[0]!;
    expect(gate).toContain("shell: bash"); // Explicit Bash enables GitHub's -eo pipefail.
    expect(gate).toContain("2>&1 | tee dist/web-guests-");
  }
});

for (const path of [
  "web/scripts/node-spawn.ts", "web/scripts/node-host.mjs", "web/scripts/node-worker.ts", "web/scripts/node-process.ts", "web/src/net/trampoline.ts",
  "web/src/engine-host.js", "web/src/crypto-inputs.js", "web/bun.lock", "web/guest-tests/compose.ts",
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

for (const path of ["web/src/main.ts", "web/src/editor.ts", "sandbox/src/main.ts", "site/src/main.ts", "docs/code-quality.md"]) {
  test(`${path} does not compile engines for a UI or documentation change`, () => {
    expect(needsRust([path])).toBe(false);
    expect(needsJsc([path])).toBe(false);
  });
}

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
});

test("the background prebuild is verified and saved before every guest producer and gate", () => {
  const names = nativeStepNames();
  const owner = "Build or verify the JSC prebuild";
  const launch = "Start the JSC prebuild beside native quality";
  const later = ["Start the JSC Cargo guest build", "Blocking JSC embedding and allocation checks", "Build one host-engine guest for real-browser source cache acceptance", "Build the single tools fixture in the existing native target", "Blocking Web guest cases (QuickJS and host engine)", "Blocking Web guest case (JSC)", "Save the JSC prebuild cache once per input revision", "Save the JSC Cargo cache once per input revision", "Save the refined native Cargo cache once per input revision"];
  for (const step of [owner, launch].concat(later)) expect(names.filter(value => value === step)).toHaveLength(1);
  for (const step of later) expect(names.indexOf(step)).toBeGreaterThan(names.indexOf(owner));
  expect(names.indexOf(launch)).toBeLessThan(names.indexOf("Blocking native quality checks"));
  expect(names.indexOf(owner)).toBeGreaterThan(names.indexOf("Save the native quality checkpoint"));
  expect(workflow.match(/bash scripts\/build-jsc.sh/g)).toHaveLength(1);
  expect(workflow.match(/bash scripts\/build-bun-jsc.sh/g)).toHaveLength(1);
  const prebuild = rust.split(`      - name: ${owner}\n`)[1]!.split("      - name: Save the JSC prebuild cache")[0]!;
  expect(prebuild).toContain('cat "$RUNNER_TEMP/jsc-prebuild.log"\n          [[ "$(cat "$state/completion")" == verified ]]\n          echo "jsc-ready=true" >> "$GITHUB_OUTPUT"');
  expect(prebuild).not.toContain("run_native_checks");
  expect(prebuild).not.toContain("continue-on-error");
  expect(prebuild).not.toContain("uses: actions/cache/save");
  expect(rust).toContain("dist/web-guests-*.log\n            ${{ runner.temp }}/jsc-prebuild.log");
  expect(rust).toContain("if: always()\n        with:\n          name: web-guest-fixture-receipts");
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
