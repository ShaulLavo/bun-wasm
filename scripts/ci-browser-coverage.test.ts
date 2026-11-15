import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { needsRust, needsJsc } from "./ci-changes";
import { browserCoverageOutputs, browserCoverageSnapshot } from "./ci-browser-coverage";
import { selectBrowserGuestCoverage, browserGuestManifest } from "./browser-guest-selection";
import { expectedBrowserGuestRows, fullBrowserGuestSelection, coverageOwners } from "./browser-guest-catalogue";

const cleanup = new Set<string>();
afterEach(() => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); cleanup.clear(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-coverage-git-")); cleanup.add(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-b", "fixture"); git("config", "user.name", "Coverage fixture"); git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(directory, "checks"));
  for (const owner of coverageOwners) writeFileSync(join(directory, `checks/browser-guest-${owner}.json`), JSON.stringify(browserGuestManifest(owner)));
  git("add", "."); git("commit", "-m", "base manifests");
  return { directory, git, base: git("rev-parse", "HEAD") };
}
test("real manifest snapshots retain removed shared, QuickJS, generator and preview edges", () => {
  const { directory, git, base } = fixture();
  rmSync(join(directory, "checks"), { recursive: true });
  git("add", "."); git("commit", "-m", "remove manifests");
  const head = git("rev-parse", "HEAD");
  const snapshots = [browserCoverageSnapshot(base, "base", directory), browserCoverageSnapshot(head, "head", directory), browserCoverageSnapshot(base, "merge-ancestor", directory)];
  for (const [path, count] of [
    ["crates/bunwasm-engine-quickjs/src/transport.rs", 20], ["third_party/rquickjs-sys/src/lib.rs", 11],
    ["web/src/preview-websocket-client.ts", 4], ["scripts/generate-node-path.ts", 44],
    ["scripts/generate-dev-html-client.ts", 44], ["web/src/dev-html-client.ts", 44],
    ["scripts/src/engine-init.c", 20], ["scripts/src/engine-explicit-init.ts", 20], ["scripts/build-bash-web-shell.sh", 44],
  ] as const) {
    const selection = selectBrowserGuestCoverage({ changedPaths: [path], snapshots, full: false });
    expect(expectedBrowserGuestRows(selection), path).toHaveLength(count);
  }
});
test("Git snapshots reject symlink manifests and directories", () => {
  const { directory, git } = fixture();
  rmSync(join(directory, "checks/browser-guest-worker-modules.json"));
  symlinkSync("../outside", join(directory, "checks/browser-guest-worker-modules.json"));
  git("add", "."); git("commit", "-m", "unsafe manifest");
  expect(() => browserCoverageSnapshot(git("rev-parse", "HEAD"), "head", directory)).toThrow("Unsafe check manifest");
  rmSync(join(directory, "checks"), { recursive: true });
  symlinkSync("outside", join(directory, "checks"));
  git("add", "."); git("commit", "-m", "unsafe directory");
  expect(() => browserCoverageSnapshot(git("rev-parse", "HEAD"), "head", directory)).toThrow("Unsafe check directory");
});
test("selected batches keep existing Storage/default cells and narrower engines", () => {
  expect(browserCoverageOutputs([])).toContain('batches=["10-storage","default"]');
  const quickjs = browserCoverageOutputs([{ owner: "installer-links", engines: ["quickjs"] }]);
  expect(quickjs).toContain('batches=["10-storage","20-installer-links","default"]');
  expect(quickjs).toContain("needed=true\njsc=false");
  expect(browserCoverageOutputs([{ owner: "installer-links", engines: ["jsc"] }])).toContain("jsc=true");
  expect(JSON.parse(browserCoverageOutputs(fullBrowserGuestSelection).split("\n")[0]!.slice(8))).toHaveLength(9);
});
test("CI passes selected cells to same-run site consumers and builds interruption once", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const producer = readFileSync(new URL("../.github/actions/native-production/action.yml", import.meta.url), "utf8").split("name: Build the browser-guest site once")[1]!.split("- name:")[0]!;
  expect(producer.match(/browser-guest-site.ts build/g)).toHaveLength(1);
  expect(producer.match(/browser-guest-coverage.ts/g)).toHaveLength(1);
  expect(producer).toContain('bun scripts/browser-guest-coverage.ts "$RUNNER_TEMP/browser-guest-site" "$BUN_WASM_BROWSER_COVERAGE_SELECTION"');
  expect(workflow.match(/BUN_WASM_BROWSER_COVERAGE_SELECTION: \$\{\{ needs.selection.outputs.browser-coverage-selection \}\}/g)).toHaveLength(3);
  expect(workflow).not.toContain("browser-guest-coverage.ts");
  const consumer = workflow.split("\n  browser-guest:\n")[1]!.split("\n  browser-process:\n")[0]!;
  expect(consumer).toContain("BUN_WASM_BROWSER_COVERAGE_SELECTION");
  expect(consumer).toContain("BUN_WASM_BROWSER_COVERAGE_REPORTS");
  expect(consumer).toContain("startsWith(matrix.batch, '2') && 3240 || 900");
  expect(consumer).not.toMatch(/build\.sh|test-web\.sh|coverage\.json|browser-guest-site.ts build/);
});

test("browser input declarations keep native predicates separate from selected runtime needs", () => {
  for (const path of ["web/index.html", "web/src/main.ts", "web/src/playground/app.tsx"]) {
    expect(needsRust([path])).toBe(false);
    expect(needsJsc([path])).toBe(false);
  }
  const quickjs = browserCoverageOutputs([{ owner: "installer-links", engines: ["quickjs"] }]);
  expect(quickjs).toContain("needed=true\njsc=false");
});

test.each(["native-setup", "native-seed", "native-production"])("production action %s selects all browser owners on edit and removal", action => {
  const { directory, git, base } = fixture();
  const path = `.github/actions/${action}/action.yml`;
  mkdirSync(join(directory, `.github/actions/${action}`), { recursive: true });
  writeFileSync(join(directory, path), "introduced");
  git("add", "."); git("commit", "-m", "introduce action");
  const introduced = git("rev-parse", "HEAD");
  const select = (before: string, after: string) => selectBrowserGuestCoverage({
    changedPaths: git("diff", "--name-only", "--no-renames", before, after).split("\n"), full: false,
    snapshots: [browserCoverageSnapshot(before, "base", directory), browserCoverageSnapshot(after, "head", directory), browserCoverageSnapshot(before, "merge-ancestor", directory)],
  });
  expect(select(base, introduced)).toEqual(fullBrowserGuestSelection);
  writeFileSync(join(directory, path), "edited");
  git("add", "."); git("commit", "-m", "edit action");
  const edited = git("rev-parse", "HEAD");
  expect(select(introduced, edited)).toEqual(fullBrowserGuestSelection);
  rmSync(join(directory, path));
  git("add", "."); git("commit", "-m", "remove action");
  expect(select(edited, git("rev-parse", "HEAD"))).toEqual(fullBrowserGuestSelection);
});
