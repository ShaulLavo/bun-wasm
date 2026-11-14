import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { coverageMarker, mainCoverage } from "./ci-main-coverage";
import { needsJsc, needsRust, needsSharedNative, needsSharedSysroot, selectChanges } from "./ci-changes";
import { selectChecks } from "./test-checks";

const all = { rust: true, jsc: true, shared: true, shared_native: true };
const none = { rust: false, jsc: false, shared: false, shared_native: false };

function git(args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=CI coverage test", "-c", "user.email=ci@localhost"].concat(args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function change(path: string, content: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  git(["add", "-A"]);
  git(["commit", "-qm", path]);
  return git(["rev-parse", "HEAD"]);
}

function run(head: string, id = 1) {
  return { id, workflow_id: 77, path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: head, status: "completed", conclusion: "success", run_attempt: 2 };
}

function selectionJob(head: string) {
  return { name: "CI selection", head_sha: head, status: "completed", conclusion: "success", steps: [{ name: coverageMarker, status: "completed", conclusion: "success" }] };
}

async function fixture(body: (base: string) => Promise<void>): Promise<void> {
  const original = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-ci-main-"));
  try {
    process.chdir(directory);
    git(["init", "-q"]);
    change("checks/native-shared-example.json", JSON.stringify({ owner: "native", path: "tests/fixtures/shared-example", profile: "shared-group" }));
    const base = change("package.json", JSON.stringify({ version: "0.0.1", scripts: { check: "old" } }));
    await body(base);
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}

function api(head: string, candidates: ReturnType<typeof run>[], jobs: unknown[] = []) {
  const requests: string[] = [];
  const request = async (path: string): Promise<unknown> => {
    requests.push(path);
    if (path === "actions/runs/999") return run(head, 999);
    if (path.includes("/jobs?")) return { total_count: jobs.length, jobs };
    const sha = new URL(`https://example.test/${path}`).searchParams.get("head_sha");
    const workflow_runs = candidates.filter(candidate => candidate.head_sha === sha);
    return { total_count: workflow_runs.length, workflow_runs };
  };
  return { head, run: 999, request, requests };
}

test.each(["quickjs", "browser", "jsc"])("cumulative selection forwards the declared %s fixture engine", engine => fixture(async () => {
  change("checks/native-engine-selection.json", JSON.stringify({ owner: "native", path: "tests/fixtures/engine-selection", engines: [engine] }));
  const base = change("tests/fixtures/engine-selection/index.ts", "before");
  const head = change("tests/fixtures/engine-selection/index.ts", "after");
  const result = await mainCoverage(api(head, [run(base)], [selectionJob(base)]));
  expect(result).toMatchObject({ kind: "verified", selection: { ...none, rust: true, jsc: engine === "jsc" } });
}));

test("pending native followed by several docs replacements retains every owed family", () => fixture(async base => {
  change("jsc/changed.c", "native change");
  change("scripts/build-wasi-sysroot.ts", "sysroot change");
  change("docs/first.md", "docs");
  const head = change("docs/second.md", "more docs");
  const result = await mainCoverage(api(head, [run(base)], [selectionJob(base)]));
  expect(result).toMatchObject({ kind: "verified", base, head, run: 1, edges: 4, selection: all });
}));

test.each([".github/actions/jsc-setup/action.yml", ".github/actions/jsc-prebuild/action.yml", ".github/workflows/jsc-prebuild.yml"])("JSC coordination change %s selects PR validation and survives pending main replacement", path => fixture(async base => {
  const action = change(path, "changed JSC action");
  expect(selectChanges(base, action, true)).toEqual({ ...none, rust: true, jsc: true });
  const head = change("docs/after-action.md", "docs");
  expect(await mainCoverage(api(head, [run(base)], [selectionJob(base)]))).toMatchObject({ kind: "verified", selection: { ...none, rust: true, jsc: true } });
}));

test("reverted native paths, package inputs and manifests retain historical families", () => fixture(async base => {
  change("jsc/changed.c", "native");
  rmSync("jsc/changed.c");
  change("package.json", JSON.stringify({ version: "0.0.1", scripts: { check: "changed" } }));
  change("package.json", JSON.stringify({ version: "0.0.1", scripts: { check: "old" } }));
  change("scripts/build-wasi-sysroot.ts", "sysroot");
  rmSync("scripts/build-wasi-sysroot.ts");
  change("checks/browser-guest-intermediate.json", JSON.stringify({ owner: "browser-guest", path: "scripts/intermediate.test.ts", inputs: ["historical/input.ts"], profile: "shared-group" }));
  change("historical/input.ts", "changed");
  rmSync("historical/input.ts");
  rmSync("checks/browser-guest-intermediate.json");
  const head = change("docs/end.md", "docs");
  expect(git(["diff", "--name-only", base, head])).toBe("docs/end.md");
  expect(selectChanges(base, head)).toEqual(none);
  expect(await mainCoverage(api(head, [run(base)], [selectionJob(base)]))).toMatchObject({ kind: "verified", selection: all });
}));

test("intermediate manifest inputs survive removal on the same edge and renamed/deleted paths", () => fixture(async base => {
  const manifest = change("checks/browser-guest-historical.json", JSON.stringify({ owner: "browser-guest", path: "scripts/historical.test.ts", inputs: ["custom/input.ts"], profile: "shared-group" }));
  change("custom/input.ts", "input");
  rmSync("checks/browser-guest-historical.json");
  renameSync("custom/input.ts", "elsewhere.ts");
  const head = change("docs/end.md", "docs");
  expect(selectChanges(manifest, head)).toMatchObject({ rust: true, shared_native: true });
  const result = await mainCoverage(api(head, [run(manifest)], [selectionJob(manifest)]));
  expect(result).toMatchObject({ kind: "verified", selection: { rust: true, shared_native: true } });
  expect(result.selection.jsc).toBe(false);
  expect(base).not.toBe(manifest);
}));

test("legacy success after unresolved native work cannot establish coverage", () => fixture(async base => {
  change("jsc/native.c", "native");
  const legacy = change("docs/legacy.md", "docs");
  const head = change("docs/head.md", "docs");
  const job = selectionJob(legacy);
  job.steps = [];
  const result = await mainCoverage(api(head, [run(legacy), run(base, 2)], [job]));
  expect(result).toMatchObject({ kind: "full", selection: all, reason: "No successful marked main baseline" });
}));

test("malformed historical check metadata falls back instead of dropping its family", () => fixture(async base => {
  change("checks/native-broken.json", "{}");
  rmSync("checks/native-broken.json");
  const head = change("docs/head.md", "docs");
  expect(await mainCoverage(api(head, [run(base)], [selectionJob(base)]))).toMatchObject({ kind: "full", selection: all });
}));

test("lookup failure while inspecting an otherwise successful candidate selects all", () => fixture(async base => {
  const head = change("docs/head.md", "docs");
  const input = api(head, [run(base)], [selectionJob(base)]);
  const original = input.request;
  input.request = path => {
    if (path.includes("/jobs?")) throw new Error("Actions jobs unavailable");
    return original(path);
  };
  expect(await mainCoverage(input)).toMatchObject({ kind: "full", reason: "Actions jobs unavailable", selection: all });
}));

test("real main CLI bootstraps all flags and records its reason when API proof is unavailable", () => fixture(async () => {
  const head = change("docs/head.md", "docs");
  const output = execFileSync("bun", [join(import.meta.dir, "ci-main-coverage.ts"), head], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: head, GITHUB_RUN_ID: "999", GITHUB_REPOSITORY: "ShaulLavo/bun-wasm", GITHUB_TOKEN: "", GITHUB_STEP_SUMMARY: "coverage-summary.md" },
  });
  expect(output.trim()).toBe("selection<<ci-main-selection\nrust=true\njsc=true\nshared=true\nshared_native=true\nci-main-selection");
  expect(readFileSync("coverage-summary.md", "utf8")).toContain(`all families selected for head ${head}. Missing GITHUB_TOKEN`);
}));

test.each(["pull_request", "workflow_dispatch"])("the cumulative CLI rejects %s without replacing its original selector", event => fixture(async () => {
  const head = change("docs/head.md", "docs");
  expect(() => execFileSync("bun", [join(import.meta.dir, "ci-main-coverage.ts"), head], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main", GITHUB_TOKEN: "" },
  })).toThrow("main-push only");
}));

test("closest whole successful marked ancestor wins despite candidate ordering and reruns", () => fixture(async base => {
  change("jsc/native.c", "native");
  const recent = change("docs/verified.md", "docs");
  const head = change("docs/head.md", "docs");
  const input = api(head, [run(base), run(recent, 2)], [selectionJob(base), selectionJob(recent)]);
  expect(await mainCoverage(input)).toMatchObject({ kind: "verified", base: recent, run: 2, edges: 1, selection: none });
  expect(input.requests.some(path => path.includes("/runs/2/attempts/2/jobs"))).toBe(true);
  expect(input.requests.some(path => path.includes(`head_sha=${base}`))).toBe(false);
}));

test("version-only main range keeps its existing optimization after verified success", () => fixture(async base => {
  const head = change("package.json", JSON.stringify({ version: "0.0.2", scripts: { check: "old" } }));
  expect(await mainCoverage(api(head, [run(base)], [selectionJob(base)]))).toMatchObject({ kind: "verified", selection: { ...none, shared: true } });
  expect(selectChanges(base, head)).toEqual({ ...none, shared: true });
}));

test.each([
  { status: "in_progress", conclusion: null }, { conclusion: "failure" }, { conclusion: "cancelled" },
  { id: 999 }, { workflow_id: 88 }, { path: ".github/workflows/other.yml" },
  { event: "pull_request" }, { head_branch: "other" }, { head_sha: "f".repeat(40) },
])("ineligible candidate %j never advances coverage", mutation => fixture(async base => {
  const head = change("docs/head.md", "docs");
  const candidate = { ...run(base), ...mutation };
  const input = api(head, [], [selectionJob(base)]);
  const original = input.request;
  input.request = path => path.includes("/runs?") ? Promise.resolve({ total_count: 1, workflow_runs: [candidate] }) : original(path);
  expect(await mainCoverage(input)).toMatchObject({ kind: "full", selection: all });
}));

test.each([
  { conclusion: "failure" }, { status: "in_progress" }, { name: "Other selection" }, { name: "Source quality" }, { head_sha: "f".repeat(40) },
  { steps: [] }, { steps: [{ name: coverageMarker, status: "completed", conclusion: "skipped" }] },
  { steps: [{ name: "Old selection", status: "completed", conclusion: "success" }] },
])("a successful workflow needs its successful selection marker: %j", mutation => fixture(async base => {
  const head = change("docs/head.md", "docs");
  expect(await mainCoverage(api(head, [run(base)], [{ ...selectionJob(base), ...mutation }]))).toMatchObject({ kind: "full", selection: all });
}));

test("non-first-parent, descendant and current heads are rejected even with successful proof", () => fixture(async base => {
  git(["checkout", "-qb", "side"]);
  const side = change("docs/side.md", "side");
  git(["checkout", "-q", "--detach", base]);
  const main = change("docs/main.md", "main");
  git(["merge", "--no-ff", "-qm", "side merge", "side"]);
  const head = git(["rev-parse", "HEAD"]);
  const descendant = change("docs/future.md", "future");
  git(["checkout", "-q", "--detach", head]);
  const input = api(head, [run(side), run(descendant, 2), run(head, 3)], [selectionJob(side), selectionJob(descendant), selectionJob(head)]);
  expect(await mainCoverage(input)).toMatchObject({ kind: "full", selection: all });
  expect(input.requests.some(path => path.includes(`head_sha=${side}`))).toBe(false);
  expect(input.requests.some(path => path.includes(`head_sha=${main}`))).toBe(true);
}));

test("paginated runs and attempt jobs retain marker eligibility", () => fixture(async base => {
  const head = change("docs/head.md", "docs");
  const input = api(head, [], []);
  input.request = async path => {
    if (path === "actions/runs/999") return run(head, 999);
    if (path.includes("/jobs?")) return { total_count: 101, jobs: path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ name: "Other job" })) : [selectionJob(base)] };
    if (path.includes(`head_sha=${base}`)) return { total_count: 101, workflow_runs: path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ ...run(base), conclusion: "failure" })) : [run(base)] };
    return { total_count: 0, workflow_runs: [] };
  };
  expect(await mainCoverage(input)).toMatchObject({ kind: "verified", base, selection: none });
}));

test.each(["api", "pages", "jobs", "time", "edges", "history", "malformed", "partial-page", "shallow"])("%s failure falls back to all families", failure => fixture(async base => {
  const next = change("docs/next.md", "docs");
  const head = change("docs/head.md", "docs");
  const input = api(head, [run(base)], [selectionJob(base)]);
  const bounds = { edges: 64, pages: 80, jobInspections: 24, milliseconds: 30_000 };
  if (failure === "api") input.request = async () => { throw new Error("HTTP 403"); };
  if (failure === "pages") bounds.pages = 1;
  if (failure === "jobs") bounds.jobInspections = 0;
  if (failure === "edges") bounds.edges = 1;
  if (failure === "history") input.head = "f".repeat(40);
  if (failure === "shallow") writeFileSync(".git/shallow", `${next}\n`);
  if (failure === "malformed") input.request = async () => ({ workflow_runs: [] });
  if (failure === "partial-page") input.request = async path => path === "actions/runs/999" ? run(head, 999) : { total_count: 101, workflow_runs: [] };
  let time = 0;
  const now = failure === "time" ? () => time += 30_001 : () => 0;
  expect(await mainCoverage({ ...input, bounds, now })).toMatchObject({ kind: "full", selection: all });
}));

test("selection and immutable-ref implementation changes select every conditional family", () => {
  for (const path of ["scripts/ci-main-coverage.ts", "scripts/ci-changes.ts", "scripts/ci-check-inputs.ts", "scripts/ci-refs.ts", ".github/workflows/ci.yml"]) {
    expect(needsRust([path]), path).toBe(true);
    expect(needsJsc([path]), path).toBe(true);
    expect(needsSharedSysroot([path]), path).toBe(true);
    expect(needsSharedNative([path]), path).toBe(true);
  }
  expect(selectChecks("quality")).toContain("scripts/ci-main-coverage.test.ts");
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

test("only selection gets read-only Actions access and main marker wiring preserves immutable refs", () => {
  const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
  const jobs = object(workflow.jobs);
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = object(jobs.selection);
  expect(job.permissions).toEqual({ contents: "read", actions: "read" });
  if (!Array.isArray(job.steps)) throw new Error("Expected selection steps");
  const steps = job.steps.map(object);
  const marker = steps.find(step => step.name === coverageMarker);
  expect(marker).toMatchObject({ id: "main-coverage", if: "github.event_name == 'push' && github.ref == 'refs/heads/main'", env: { HEAD: "${{ steps.refs.outputs.head }}" } });
  expect(steps.find(step => step.id === "refs")?.run).toBe('bun scripts/ci-refs.ts >> "$GITHUB_OUTPUT"');
  expect(steps.find(step => step.uses === "actions/checkout@v4")?.with).toEqual({ "fetch-depth": 0 });
  expect(steps.find(step => step.id === "changes")?.env).toEqual({ BASE: "${{ steps.refs.outputs.base }}", HEAD: "${{ steps.refs.outputs.head }}", MAIN_SELECTION: "${{ steps.main-coverage.outputs.selection }}" });
  expect(steps.find(step => step.id === "changes")?.run).toContain('bun scripts/ci-changes.ts "$BASE" "$HEAD"');
  for (const [id, value] of Object.entries(jobs)) {
    if (id === "selection") continue;
    expect(object(object(value).permissions ?? {}).actions).toBe(["native-quality", "rust", "shared-sysroot"].includes(id) ? "write" : undefined);
  }
});

test("cumulative admission preserves the blocking job graph, browser matrix and deadlines", () => {
  const workflow = object(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
  const jobs = object(workflow.jobs);
  const graph = Object.fromEntries(Object.entries(jobs).map(([id, value]) => {
    const job = object(value);
    expect(job["continue-on-error"], id).toBeUndefined();
    return [id, { needs: job.needs ?? [], minutes: job["timeout-minutes"] }];
  }));
  expect(graph).toEqual({
    selection: { needs: [], minutes: 5 },
    quality: { needs: "selection", minutes: 10 },
    "jsc-identity": { needs: "selection", minutes: 15 },
    "jsc-prebuild": { needs: ["selection", "jsc-identity"], minutes: 45 },
    "native-quality": { needs: ["selection", "jsc-prebuild"], minutes: 45 },
    rust: { needs: ["selection", "jsc-prebuild", "native-quality"], minutes: 60 },
    package: { needs: "selection", minutes: 10 },
    "shared-jsc-identity": { needs: "selection", minutes: 15 },
    "shared-prebuild": { needs: ["selection", "shared-jsc-identity"], minutes: 45 },
    "shared-spidermonkey-prebuild": { needs: ["selection", "shared-prebuild"], minutes: 30 },
    "shared-sysroot": { needs: ["selection", "rust", "shared-prebuild", "shared-spidermonkey-prebuild"], minutes: 30 },
    web: { needs: ["selection", "web-unit", "web-browser"], minutes: 10 },
    "web-unit": { needs: "selection", minutes: 10 },
    "web-browser": { needs: "selection", minutes: 10 },
    "process-bundles": { needs: "selection", minutes: 10 },
    "browser-guest": { needs: ["selection", "rust"], minutes: 10 },
    "browser-process": { needs: ["selection", "rust", "process-bundles", "browser-guest"], minutes: 10 },
    "ci-result": { needs: ["selection", "quality", "jsc-identity", "jsc-prebuild", "native-quality", "rust", "package", "shared-jsc-identity", "shared-prebuild", "shared-spidermonkey-prebuild", "shared-sysroot", "web", "web-unit", "web-browser", "process-bundles", "browser-guest", "browser-process"], minutes: 5 },
    "update-status": { needs: ["selection", "quality", "jsc-identity", "jsc-prebuild", "native-quality", "rust", "package", "shared-jsc-identity", "shared-prebuild", "shared-spidermonkey-prebuild", "shared-sysroot", "web", "web-unit", "web-browser", "process-bundles", "browser-guest", "browser-process", "ci-result"], minutes: 5 },
  });
  const browser = object(jobs["browser-process"]);
  expect(object(browser.strategy).matrix).toEqual({ browser: ["chromium", "firefox", "webkit"] });
  expect(browser.if).toContain("needs.process-bundles.result == 'success'");
  expect(browser.if).toContain("needs.rust.result == 'success' || needs.rust.result == 'skipped'");
});
