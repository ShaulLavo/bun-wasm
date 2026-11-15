import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { browserGuestRows, coverageOwners, expectedBrowserGuestRows, fullBrowserGuestSelection, withoutJscBrowserGuestSelection, unionBrowserGuestSelections, rowIdentity, parseBrowserGuestSelection } from "./browser-guest-catalogue";
import { browserGuestManifest, browserGuestOwnerInputs, selectBrowserGuestCoverage, type CoverageManifestSnapshot } from "./browser-guest-selection";

const cleanup = new Set<string>();
afterEach(() => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); cleanup.clear(); });
function snapshots(): CoverageManifestSnapshot[] {
  return (["base", "head", "merge-ancestor"] as const).map(role => ({ role, ref: "a".repeat(40), manifests: [] }));
}
const select = (changedPaths: string[]) => selectBrowserGuestCoverage({ changedPaths, snapshots: snapshots(), full: false });

test("catalogue equals the exact audit tuples, including explicit 44/35 and 23/21 subsets", () => {
  const rows = readFileSync(new URL("./fixtures/browser-guest-rows.tsv", import.meta.url), "utf8").trimEnd().split("\n").slice(1).map(line => JSON.stringify(line.split("\t")));
  expect(browserGuestRows.map(rowIdentity)).toEqual(rows);
  expect(new Set(rows).size).toBe(44);
  expect(expectedBrowserGuestRows(fullBrowserGuestSelection)).toHaveLength(44);
  expect(expectedBrowserGuestRows(withoutJscBrowserGuestSelection)).toHaveLength(35);
  expect(expectedBrowserGuestRows(fullBrowserGuestSelection, "chromium")).toHaveLength(23);
  expect(expectedBrowserGuestRows(fullBrowserGuestSelection, "webkit")).toHaveLength(21);
  expect(rows.every(left => rows.every(right => left === right || !right.startsWith(left)))).toBe(true);
  const legs = expectedBrowserGuestRows(fullBrowserGuestSelection, "chromium").concat(expectedBrowserGuestRows(fullBrowserGuestSelection, "webkit"));
  expect(new Set(legs.map(rowIdentity)).size).toBe(44);
});

test("owner drivers select only their explicit complete engine family", () => {
  for (const owner of coverageOwners) {
    const driver = browserGuestOwnerInputs(owner).find(path => path.startsWith("web/tests/browser-") && path !== "web/tests/browser-type.ts");
    expect(driver).toBeDefined();
    expect(select([driver!])).toEqual(fullBrowserGuestSelection.filter(item => item.owner === owner));
  }
});
test("engine producer changes retain narrower QuickJS, JSC and Browser predicates", () => {
  const jsc = select(["crates/bunwasm-engine-jsc/src/vm.rs"]);
  expect(jsc.every(item => item.engines.join() === "jsc")).toBe(true);
  expect(expectedBrowserGuestRows(jsc)).toHaveLength(9);
  const browser = select(["scripts/build-bun-browser.sh"]);
  expect(browser.every(item => item.engines.join() === "browser")).toBe(true);
  const quickjs = select(["third_party/rquickjs-sys/src/lib.rs"]);
  expect(quickjs.every(item => item.engines.join() === "quickjs")).toBe(true);
  expect(expectedBrowserGuestRows(quickjs)).toHaveLength(11);
  expect(select(["crates/bunwasm-runtime/src/engine_quickjs.rs"])).toEqual(quickjs);
  expect(select(["crates/bunwasm-runtime/src/engine_host.rs"])).toEqual(browser);
  expect(select(["scripts/build-bun-tools.sh"])).toEqual(fullBrowserGuestSelection.filter(item => item.owner === "tools-integrity"));
});
test("shared runtime selects full rows; serving/startup inputs select their actual page owners", () => {
  expect(select(["crates/bunwasm-runtime/src/host.rs"])).toEqual(fullBrowserGuestSelection);
  for (const input of ["scripts/accept-encoding.ts", "web/src/playground/app.tsx", "web/src/playground/terminal-pane.tsx", "web/src/terminal-mount.ts", "web/src/startup.ts"]) {
    const selected = select([input]);
    expect(selected.some(item => item.owner === "terminal-stdin")).toBe(true);
    expect(selected.some(item => item.owner === "installer-links")).toBe(true);
  }
  expect(select(["web/src/playground/app.tsx"]).some(item => item.owner === "engine-interruption")).toBe(false);
});
test("unrelated native fixtures, CLI rows, Storage templates, declarations and UI stay outside new coverage", () => {
  for (const path of ["tests/fixtures/if-completion/index.ts", "tests/cli/args.test.ts", "sandbox/src/sandbox.ts", "sandbox/templates/react/src/app.tsx", "web/src/settings.tsx", "docs/development.md", "crates/bunwasm-runtime/src/js/runtime.d.ts"]) expect(select([path])).toEqual([]);
  expect(select(["tests/fixtures/spawn-stdin/expected.txt"]).map(item => item.owner)).toEqual(["subprocess"]);
});

test("genuine base/head/ancestor blobs preserve removed manifest/helper inputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-selection-")); cleanup.add(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-b", "fixture"); git("config", "user.name", "Coverage fixture"); git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(directory, "checks"));
  const file = "checks/browser-guest-installer-links.json";
  writeFileSync(join(directory, file), JSON.stringify({ ...browserGuestManifest("installer-links"), inputs: ["web/old-helper.ts"] }));
  git("add", "."); git("commit", "-m", "base manifest"); const base = git("rev-parse", "HEAD");
  rmSync(join(directory, file)); git("add", "."); git("commit", "-m", "remove manifest"); const head = git("rev-parse", "HEAD");
  const read = (ref: string, role: CoverageManifestSnapshot["role"]): CoverageManifestSnapshot => ({ role, ref,
    manifests: git("ls-tree", "-r", "--name-only", ref, "--", "checks").split("\n").filter(Boolean).map(file => ({ file, value: JSON.parse(git("show", `${ref}:${file}`)) })) });
  const snapshots = [read(base, "base"), read(head, "head"), read(git("merge-base", base, head), "merge-ancestor")];
  for (const path of [file, "web/old-helper.ts"]) expect(selectBrowserGuestCoverage({ changedPaths: [path], snapshots, full: false })).toEqual(fullBrowserGuestSelection.filter(item => item.owner === "installer-links"));
});
test("the complete current manifest corpus preserves unrelated owners with matching numeric batches", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir, encoding: "utf8" }).trim();
  const checks = new URL("../checks/", import.meta.url);
  const manifests = readdirSync(checks).map(file => ({ file: "checks/" + file, value: JSON.parse(readFileSync(new URL(file, checks), "utf8")) }));
  const current = snapshots().map(snapshot => ({ ...snapshot, ref: head, manifests }));
  expect(selectBrowserGuestCoverage({ changedPaths: ["web/src/playground/app.tsx"], snapshots: current, full: false })).toEqual(select(["web/src/playground/app.tsx"]));
});

test("selection rejects malformed snapshots and unions owner/engine sets without global Rust coupling", () => {
  expect(() => selectBrowserGuestCoverage({ changedPaths: [], snapshots: [], full: false })).toThrow("snapshots");
  const bad = snapshots();
  expect(() => selectBrowserGuestCoverage({ changedPaths: ["../unsafe"], snapshots: bad, full: false })).toThrow("Unsafe");
  expect(unionBrowserGuestSelections(select(["scripts/build-bun-browser.sh"]), select(["crates/bunwasm-engine-jsc/src/lib.rs"])))
    .toEqual(unionBrowserGuestSelections(select(["crates/bunwasm-engine-jsc/src/lib.rs"]), select(["scripts/build-bun-browser.sh"])));
  expect(selectBrowserGuestCoverage({ changedPaths: [], snapshots: snapshots(), full: true })).toEqual(fullBrowserGuestSelection);
});
test("serialized owner/engine outputs fail closed for absent, unknown, duplicate and inapplicable selections", () => {
  expect(parseBrowserGuestSelection(JSON.parse(JSON.stringify(fullBrowserGuestSelection)))).toEqual(fullBrowserGuestSelection);
  for (const value of [undefined, {}, [{ owner: "unknown", engines: ["browser"] }], [{ owner: "terminal-stdin", engines: [] }],
    [{ owner: "terminal-stdin", engines: ["jsc"] }], [{ owner: "worker-modules", engines: ["browser", "browser"] }],
    [{ owner: "worker-modules", engines: ["browser"] }, { owner: "worker-modules", engines: ["browser"] }]]) expect(() => parseBrowserGuestSelection(value)).toThrow();
});

test("actual shared side modules and initializer inputs keep both QuickJS and JSC", () => {
  for (const path of ["crates/bunwasm-engine-quickjs/src/transport.rs", "crates/bunwasm-engine-quickjs/src/side_modules.rs", "crates/bunwasm-engine-quickjs/src/allocator.rs", "scripts/src/engine-init.c", "scripts/src/engine-explicit-init.ts"]) {
    const selected = select([path]);
    expect(expectedBrowserGuestRows(selected)).toHaveLength(20);
    expect(selected.every(item => !item.engines.includes("browser"))).toBe(true);
    expect(selected.some(item => item.engines.includes("jsc"))).toBe(true);
  }
  expect(expectedBrowserGuestRows(select(["crates/bunwasm-engine-quickjs/src/vm.rs"]))).toHaveLength(11);
});
test("real runtime generators, pinned shell and wrapper select their applicable owners", () => {
  for (const path of ["scripts/generate-node-path.ts", "scripts/generate-dev-html-client.ts", "web/src/dev-html-client.ts", "scripts/build-bash-web-shell.sh", "scripts/browser-guest-wrapper.ts"]) {
    expect(select([path])).toEqual(fullBrowserGuestSelection);
  }
  expect(select(["web/src/preview-websocket-client.ts"])).toEqual(fullBrowserGuestSelection.filter(item => item.owner === "preview-websocket"));
});

test.each(["scripts/waffle-release-inputs.ts", "scripts/waffle-release-inputs.json"])("shared sysroot input %s selects every owner on edits and removals", path => {
  expect(select([path])).toEqual(fullBrowserGuestSelection);
  for (const owner of coverageOwners) expect(browserGuestManifest(owner).inputs).toContain(path);
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-sysroot-selection-")); cleanup.add(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-b", "fixture"); git("config", "user.name", "Coverage fixture"); git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(directory, "scripts")); mkdirSync(join(directory, "checks"));
  writeFileSync(join(directory, path), "original\n");
  for (const owner of coverageOwners) writeFileSync(join(directory, `checks/browser-guest-${owner}.json`), JSON.stringify(browserGuestManifest(owner)));
  git("add", "."); git("commit", "-m", "before"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(directory, path), "changed\n"); git("add", "."); git("commit", "-m", "edit"); const changed = git("rev-parse", "HEAD");
  rmSync(join(directory, path)); git("add", "."); git("commit", "-m", "remove"); const removed = git("rev-parse", "HEAD");
  const read = (ref: string, role: CoverageManifestSnapshot["role"]): CoverageManifestSnapshot => ({ role, ref,
    manifests: git("ls-tree", "-r", "--name-only", ref, "--", "checks").split("\n").filter(Boolean).map(file => ({ file, value: JSON.parse(git("show", `${ref}:${file}`)) })) });
  const comparisons: [string, string][] = [[base, changed], [changed, removed]];
  for (const [before, after] of comparisons) {
    const state = [read(before, "base"), read(after, "head"), read(before, "merge-ancestor")];
    expect(selectBrowserGuestCoverage({ changedPaths: [path], snapshots: state, full: false })).toEqual(fullBrowserGuestSelection);
  }
});
