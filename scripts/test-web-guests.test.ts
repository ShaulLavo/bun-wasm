import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";
import { hash } from "./guest-source-manifest";
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
    // Parser-only bytes, never passed to the execution runner or used as a tools guest.
    const bytes = new TextEncoder().encode("receipt validation fixture");
    const sourceManifest = {
      schema: 1,
      build: "quickjs",
      source: { head: "d".repeat(40), tree: "e".repeat(40) },
      groups: ["repository", "bun", "waffle-libc", "sysroot", "sdk", "rust-target", "boringssl"].map(name => ({
        name,
        files: [{
          path: name === "sysroot" ? "bun-wasm-sysroot.json" : "fixture.txt",
          sha256: hash("fixture"),
          bytes: 7,
        }],
      })),
      tools: ["rustc", "cargo", "bun", "node", "rust-lld", "clang", "clang++", "llvm-ar", "wasm-ld", "cmake", "ninja"].map(name => ({
        name, path: `/fixture/${name}`, sha256: hash(name), version: "fixture only",
      })),
      omissions: ["Synthetic receipt for the fixture validation path only."],
    };
    const receipt = {
      bunHead: "a".repeat(40), bunTree: "b".repeat(40), sysrootReceiptSha256: hash("fixture"),
      sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)),
      artifactSha256: hash(bytes), artifactBytes: bytes.length,
      quickjs: { artifactSha256: hash(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), artifactBytes: 8 },
    };
    const guest = join(directory, "dist/bun.wasm");
    writeFileSync(guest, bytes);
    writeFileSync(join(directory, "dist/quickjs.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    writeFileSync(`${guest}.build.json`, JSON.stringify(receipt));
    await expect(prepareWebGuestFixtures(directory, "quickjs")).rejects.toThrow("dist/bun-tools.wasm");
    const tools = join(directory, "dist/bun-tools.wasm");
    writeFileSync(tools, bytes);
    writeFileSync(`${tools}.build.json`, JSON.stringify({ ...receipt, bunTree: "d".repeat(40) }));
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
  expect(browser.match(/test\(/g)).toHaveLength(2);
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
  expect(rust).toContain('guest-build-receipt.ts write dist/bun.wasm "$guest_inputs"');
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

test("the completed prebuild is saved before native checks and every later guest gate", () => {
  const names = nativeStepNames();
  const owner = "Build or verify the JSC prebuild";
  const later = ["Blocking JSC embedding and allocation checks", "Build one host-engine guest for real-browser source cache acceptance", "Build the single tools fixture in the existing native target", "Blocking Web guest cases (QuickJS and host engine)", "Blocking Web guest case (JSC)", "Save the JSC prebuild cache once per input revision", "Save the JSC Cargo cache once per input revision", "Save the refined native Cargo cache once per input revision", "Save the native quality checkpoint"];
  expect(names.filter(value => value === owner)).toHaveLength(1);
  for (const step of later) {
    expect(names.filter(value => value === step)).toHaveLength(1);
    expect(names.indexOf(step)).toBeGreaterThan(names.indexOf(owner));
  }
  expect(workflow.match(/bash scripts\/build-jsc.sh/g)).toHaveLength(1);
  expect(workflow.match(/bash scripts\/build-bun-jsc.sh/g)).toHaveLength(1);
  const prebuild = rust.split(`      - name: ${owner}\n`)[1]!.split("      - name: Save the JSC prebuild cache")[0]!;
  expect(prebuild).toContain('wait "$jsc_pid"\n          [[ "$(cat "$jsc_completion")" == verified ]]\n          echo "jsc-ready=true" >> "$GITHUB_OUTPUT"');
  expect(prebuild).not.toContain("run_native_checks");
  expect(prebuild).not.toContain("continue-on-error");
  expect(prebuild).not.toContain("uses: actions/cache/save");
  expect(names.indexOf("Save the JSC prebuild cache once per input revision")).toBeLessThan(names.indexOf("Blocking native quality checks"));
  expect(rust).toContain("dist/web-guests-*.log\n            ${{ runner.temp }}/jsc-prebuild.log");
  expect(rust).toContain("if: always()\n        with:\n          name: web-guest-fixture-receipts");
});
