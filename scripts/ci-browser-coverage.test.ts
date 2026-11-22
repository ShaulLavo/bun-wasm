import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { needsRust, needsJsc } from "./ci-changes";
import { browserCoverageOutputs, browserCoverageSnapshot } from "./ci-browser-coverage";
import { selectBrowserGuestCoverage, browserGuestManifest } from "./browser-guest-selection";
import { expectedBrowserGuestRows, fullBrowserGuestSelection, coverageOwners } from "./browser-guest-catalogue";
import { parseCheck } from "./test-checks";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const cleanup = new Set<string>();
test("actual repository declarations remain raw and the real PR entrypoint accepts the full corpus", () => {
  const cwd = new URL("..", import.meta.url).pathname;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const snapshot = browserCoverageSnapshot(head, "head", cwd);
  for (const { file, value } of snapshot.manifests) {
    const original: unknown = JSON.parse(execFileSync("git", ["show", `${head}:${file}`], { cwd, encoding: "utf8" }));
    expect(value).toEqual(original);
    expect(() => parseCheck(value, file.slice("checks/".length))).not.toThrow();
  }
  const result = spawnSync(process.execPath, [new URL("./ci-browser-coverage.ts", import.meta.url).pathname, head, head], {
    cwd, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", BROWSER_COVERAGE_SELECTION: "" },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("needed=false");
}, 60_000);
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
    ["scripts/wasm-name-sections.ts", 24], ["scripts/stage-guest-wasm.ts", 44],
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
  const verify = (selection: Parameters<typeof browserCoverageOutputs>[0], batches: string[], count: number) => {
    const [matrix, ...outputs] = browserCoverageOutputs(selection).split("\n");
    if (!matrix?.startsWith("matrix=")) throw new Error("Missing browser guest matrix");
    const { include } = JSON.parse(matrix.slice("matrix=".length));
    expect(include).toHaveLength(count);
    for (const browser of ["chromium", "webkit"]) {
      const names = include.filter((job: { browser: string }) => job.browser === browser)
        .flatMap((job: { batches: { name: string }[] }) => job.batches.map(batch => batch.name));
      expect(names.toSorted()).toEqual(batches);
    }
    return outputs.join("\n");
  };
  verify([], ["10-storage", "default"], 4);
  expect(verify([{ owner: "installer-links", engines: ["quickjs"] }], ["10-storage", "20-installer-links", "default"], 4)).toContain("needed=true\njsc=false");
  expect(browserCoverageOutputs([{ owner: "installer-links", engines: ["jsc"] }])).toContain("jsc=true");
  verify(fullBrowserGuestSelection, ["10-storage", "20-installer-links", "21-subprocess-aliases", "22-preview-websocket-headers", "23-engine-interruption", "24-worker-modules", "25-terminal-stdin", "26-tools-integrity", "default"], 4);
});

test.each([0, 1, 124])("the actual CI batch runner keeps independent results when the first command exits %s", firstStatus => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-browser-shard-"));
  cleanup.add(directory);
  mkdirSync(join(directory, "web"));
  writeFileSync(join(directory, "bun"), `#!/bin/bash
    read -r _ && exit 99
    printf '%s %s\\n' "$2" "$7" >> ../commands
    test "$BUN_WASM_BROWSER_REPORT_DIR" = "$BUN_WASM_BROWSER_COVERAGE_REPORTS" || exit 98
    printf '%s\\n' "$7" > "$BUN_WASM_BROWSER_REPORT_DIR/check.txt"
    if [[ "$7" == 21-subprocess-aliases ]]; then exit "\${FIRST_STATUS}"; fi
  `, { mode: 0o755 });
  const reports = join(directory, "reports");
  const summary = join(directory, "summary");
  const started = String(Math.floor(Date.now() / 1000) - 120);
  const result = spawnSync(process.execPath, [new URL("./ci-browser-guest-run.ts", import.meta.url).pathname], {
    cwd: join(directory, "web"), encoding: "utf8", env: { ...process.env, FIRST_STATUS: String(firstStatus),
      PATH: `${directory}:${process.env.PATH}`, GITHUB_WORKSPACE: directory, GITHUB_STEP_SUMMARY: summary,
      BUN_WASM_BROWSER_REPORT_DIR: reports, BUN_WASM_TEST_BROWSERS: "chromium", BROWSER_GUEST_SETUP_STARTED: started,
      BROWSER_GUEST_BATCHES: JSON.stringify([{ name: "21-subprocess-aliases", group: "suite", jobSeconds: 3600, commandSeconds: 3240 },
        { name: "default", group: "suite", jobSeconds: 600, commandSeconds: 900 }]),
    },
  });
  expect(result.status, result.stderr).toBe(firstStatus === 0 ? 0 : 1);
  const lines = readFileSync(join(directory, "commands"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("3240 21-subprocess-aliases");
  expect(lines[1]).toMatch(/^4(?:7[89]|80) default$/);
  expect(readFileSync(join(reports, "21-subprocess-aliases/check.txt"), "utf8")).toBe("21-subprocess-aliases\n");
  expect(readFileSync(join(reports, "default/check.txt"), "utf8")).toBe("default\n");
  expect(readFileSync(summary, "utf8")).toContain(`21-subprocess-aliases | ${firstStatus}\n`);
  expect(readFileSync(summary, "utf8")).toContain("default | 0\n");
});
test("CI passes selected cells to same-run site consumers and builds interruption once", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const producer = readFileSync(new URL("../.github/actions/native-production/action.yml", import.meta.url), "utf8").split("name: Build the browser-guest site once")[1]!.split("- name:")[0]!;
  expect(producer.match(/browser-guest-site.ts build/g)).toHaveLength(1);
  expect(producer.match(/browser-guest-coverage.ts/g)).toHaveLength(1);
  expect(producer).toContain('bun scripts/browser-guest-coverage.ts "$RUNNER_TEMP/browser-guest-site" "$BUN_WASM_BROWSER_COVERAGE_SELECTION"');
  expect(workflow.match(/BUN_WASM_BROWSER_COVERAGE_SELECTION: \$\{\{ needs.selection.outputs.browser-coverage-selection \}\}/g)).toHaveLength(2);
  expect(workflow).not.toContain("browser-guest-coverage.ts");
  const consumer = workflow.split("\n  browser-guest:\n")[1]!.split("\n  shared-consumers:\n")[0]!;
  const runner = readFileSync(new URL("./ci-browser-guest-run.ts", import.meta.url), "utf8");
  expect(consumer).toContain("BUN_WASM_BROWSER_COVERAGE_SELECTION");
  expect(consumer).toContain("bun ../scripts/ci-browser-guest-run.ts");
  expect(runner).toContain("BUN_WASM_BROWSER_COVERAGE_REPORTS");
  expect(runner).toContain('"browser-guest", "--batch", batch.name');
  expect(consumer.match(/name: browser-guest-site\n/g)).toHaveLength(1);
  expect(consumer).toContain('working-directory: ${{ runner.temp }}\n        run: echo "BROWSER_GUEST_SETUP_STARTED=');
  expect(consumer).toContain("name: Retain Browser guest diagnostics\n        if: ${{ always() }}");
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

test.each(["native-setup", "native-seed", "native-production", "jsc-setup", "jsc-prebuild"].map(action => `.github/actions/${action}/action.yml`).concat(["scripts/ci-binaryen.ts", "scripts/ci-build-tools.ts"]))("production input %s selects all browser owners on edit and removal", path => {
  const { directory, git, base } = fixture();
  mkdirSync(join(directory, path, ".."), { recursive: true });
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
