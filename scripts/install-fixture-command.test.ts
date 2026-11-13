import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";
import { checkCommand, selectChecks } from "./test-checks";
import { installFixture, installFixtureTargets } from "./install-fixture-command";

test("runtime tarball checks select each existing engine artifact once", () => {
  expect(installFixtureTargets({ BUN_WASM: "/wrong-single-core.wasm" }, "/fixture")).toEqual([
    { engine: "quickjs", wasm: "/fixture/dist/bun.wasm" },
    { engine: "jsc", wasm: "/fixture/dist/bun-jsc.wasm" },
    { engine: "browser", wasm: "/fixture/dist/bun-browser.wasm" },
  ]);
});

test("explicit source controls select one engine and its program without changing the matrix default", () => {
  expect(installFixtureTargets({ INSTALL_ENGINE: "quickjs", BUN_WASM: "/source-control.wasm" }, "/fixture")).toEqual([
    { engine: "quickjs", wasm: "/source-control.wasm" },
  ]);
  expect(installFixtureTargets({ INSTALL_ENGINE: "jsc" }, "/fixture")).toEqual([
    { engine: "jsc", wasm: "/fixture/dist/bun-jsc.wasm" },
  ]);
  expect(() => installFixtureTargets({ INSTALL_ENGINE: "invalid" }, "/fixture")).toThrow("Unknown install engine");
});

test("explicit CI subsets select only their producers", () => {
  expect(installFixtureTargets({ INSTALL_ENGINES: "quickjs,browser" }, "/fixture")).toEqual([
    { engine: "quickjs", wasm: "/fixture/dist/bun.wasm" },
    { engine: "browser", wasm: "/fixture/dist/bun-browser.wasm" },
  ]);
  expect(installFixtureTargets({ INSTALL_ENGINES: "quickjs,jsc,browser" }, "/fixture"))
    .toEqual(installFixtureTargets({}, "/fixture"));
  expect(installFixtureTargets({ INSTALL_ENGINES: "jsc" }, "/fixture")).toEqual([
    { engine: "jsc", wasm: "/fixture/dist/bun-jsc.wasm" },
  ]);
});

test.each(["", " ", "quickjs,", ",jsc", "quickjs,,browser", "quickjs,jsc,quickjs", "QuickJS", "quickjs, browser", "hermes", "quickjs browser"])("invalid CI subset %j fails instead of dropping checks", subset => {
  expect(() => installFixtureTargets({ INSTALL_ENGINES: subset }, "/fixture")).toThrow("INSTALL_ENGINES");
});

test.each([
  { INSTALL_ENGINE: "jsc" }, { INSTALL_ENGINE: "quickjs" }, { INSTALL_ENGINE: "" },
  { BUN_WASM: "/override.wasm" }, { BUN_WASM: "" },
])("CI subsets reject singular controls: %j", controls => {
  expect(() => installFixtureTargets({ ...controls, INSTALL_ENGINES: "quickjs,browser" }, "/fixture")).toThrow("INSTALL_ENGINES");
});

test.each(["quickjs", "jsc", "browser"])("singular %s retains its BUN_WASM override", engine => {
  expect(installFixtureTargets({ INSTALL_ENGINE: engine, BUN_WASM: "/custom.wasm" }, "/fixture"))
    .toEqual([{ engine, wasm: "/custom.wasm" }]);
});

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function workflowStep(name: string): string {
  const step = workflow.split(`      - name: ${name}\n`)[1];
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step.split("\n      - ")[0]!;
}

function ciTargets(paths: readonly string[]) {
  const selection = workflowStep("Blocking native fixture checks").match(/INSTALL_ENGINES: \$\{\{ (.+) && '([^']+)' \|\| '([^']+)' \}\}/);
  if (!selection) throw new Error("Missing explicit installer producer selection");
  expect(selection[1]).toBe("needs.quality.outputs.jsc == 'true'");
  for (const name of ["Start the JSC Cargo guest build", "Build the JSC Cargo guest"]) {
    expect(workflowStep(name)).toContain(`if: ${selection[1]}\n`);
  }
  return installFixtureTargets({ INSTALL_ENGINES: needsJsc(paths) ? selection[2] : selection[3] }, "/fixture");
}

test.each(["crates/bunwasm-host/src/linked.rs", "crates/bunwasm-host/src/nested.rs", "scripts/browser-build.ts"])("Rust-only input %s never invokes nonexistent ordinary JSC", path => {
  expect(needsRust([path])).toBe(true);
  expect(needsJsc([path])).toBe(false);
  expect(ciTargets([path])).toEqual([
    { engine: "quickjs", wasm: "/fixture/dist/bun.wasm" },
    { engine: "browser", wasm: "/fixture/dist/bun-browser.wasm" },
  ]);
});

test("installer changes retain all nine tarball cases under the single blocking runtime owner", () => {
  expect(ciTargets(["scripts/install-tarballs.test.ts"])).toEqual(installFixtureTargets({}, "/fixture"));
  expect(selectChecks("runtime").filter(path => path === "scripts/install-tarballs.test.ts")).toHaveLength(1);
  expect(checkCommand("runtime").filter(path => path.endsWith("/install-tarballs.test.ts"))).toHaveLength(1);
  const step = workflowStep("Blocking native fixture checks");
  expect(step).not.toMatch(/(?:continue-on-error|if):/);
  expect(step.match(/bun scripts\/test-checks.ts native/g)).toHaveLength(1);
  expect(step).not.toContain("install-tarballs.test.ts");
  expect(workflowStep("Build the standard Browser guest once")).toContain('BROWSER_CARGO_TARGET_DIR="$CARGO_TARGET_DIR" JOBS=2 bash scripts/build-bun-browser.sh');
  expect(step).not.toContain("ln -s source-cache-browser");
});

let scratch: string | undefined;
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

test("an explicitly selected missing JSC artifact fails the real fixture child boundary", async () => {
  scratch = mkdtempSync(join(tmpdir(), "bun-wasm-installer-selection-"));
  const launcher = join(scratch, "launcher.ts");
  // Source-only launcher: exercise argv, file loading and failure propagation without a guest build.
  writeFileSync(launcher, `#!${process.execPath}
import { readFileSync } from "node:fs";
const index = process.argv.indexOf("--wasm");
readFileSync(process.argv[index + 1]);
`, { mode: 0o700 });
  const previous = process.env.BUN_WASM_LAUNCHER;
  process.env.BUN_WASM_LAUNCHER = launcher;
  try {
    const [target] = installFixtureTargets({ INSTALL_ENGINES: "jsc" }, scratch);
    if (!target) throw new Error("Missing selected JSC target");
    expect(existsSync(target.wasm)).toBe(false);
    await expect(installFixture(scratch, "http://127.0.0.1:1", [], 0, true, [], target)).rejects.toThrow(/ENOENT.*bun-jsc\.wasm/);
  } finally {
    if (previous === undefined) delete process.env.BUN_WASM_LAUNCHER;
    else process.env.BUN_WASM_LAUNCHER = previous;
  }
});
