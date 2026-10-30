import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveComparisonRefs } from "./ci-refs";
import { verifyFeatureVersions } from "./feature-versions";

interface FixtureRefs {
  actualMain: string;
  eventBase: string;
  mergeHead: string;
  mergeRef: string;
  versionMergeRef: string;
  versionHead: string;
}

let fixture = "";
let refs: FixtureRefs;

function git(args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-C", fixture, "-c", "user.name=CI test", "-c", "user.email=ci@localhost"].concat(args),
    { encoding: "utf8" },
  ).trim();
}

function writeVersion(version: string): void {
  writeFileSync(join(fixture, "Cargo.toml"), `[workspace.package]\nversion = "${version}"\n`);
  writeFileSync(
    join(fixture, "Cargo.lock"),
    `version = 3\n\n[[package]]\nname = "bunwasm-runtime"\nversion = "${version}"\n`,
  );
}

function commit(message: string): string {
  git(["add", "."]);
  git(["commit", "-qm", message]);
  return git(["rev-parse", "HEAD"]);
}

beforeAll(() => {
  fixture = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-ci-refs-"));
  git(["init", "-q", "-b", "main"]);
  writeVersion("0.0.39");
  writeFileSync(join(fixture, "README.fixture"), "old main\n");
  const eventBase = commit("old main");

  git(["checkout", "-qb", "feature", eventBase]);
  writeFileSync(join(fixture, "feature.fixture"), "feature change\n");
  commit("feature before main advances");

  git(["checkout", "-q", "main"]);
  writeVersion("0.0.53");
  const actualMain = commit("main advances version");

  git(["checkout", "-q", "feature"]);
  git(["merge", "--no-ff", "--no-edit", "main", "-m", "compose current main into feature"]);
  const mergeHead = git(["rev-parse", "HEAD"]);

  git(["checkout", "-q", "main"]);
  git(["merge", "--no-ff", "--no-edit", "feature", "-m", "synthetic pull request merge"]);
  const mergeRef = git(["rev-parse", "HEAD"]);
  expect(git(["rev-parse", "HEAD^1"])).toBe(actualMain);
  expect(git(["rev-parse", "HEAD^2"])).toBe(mergeHead);

  git(["checkout", "-qb", "version-feature", actualMain]);
  writeVersion("0.0.54");
  const versionHead = commit("feature version change");
  git(["checkout", "-q", "main"]);
  git([
    "merge",
    "--no-ff",
    "--no-edit",
    "version-feature",
    "-m",
    "synthetic version-changing pull request",
  ]);
  const versionMergeRef = git(["rev-parse", "HEAD"]);

  git(["checkout", "--detach", "-q", mergeRef]);
  refs = { actualMain, eventBase, mergeHead, mergeRef, versionMergeRef, versionHead };
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

function resolve(
  eventName: "pull_request" | "push",
  githubSha: string,
  eventBase: string,
  eventHead: string,
) {
  return resolveComparisonRefs({ cwd: fixture, eventBase, eventHead, eventName, githubSha });
}

function select(base: string, head: string): string {
  return execFileSync("bun", [join(import.meta.dir, "ci-changes.ts"), base, head], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request" },
  }).trim();
}

test("the CLI records a stale event BASE while emitting verified parent outputs", () => {
  git(["checkout", "--detach", "-q", refs.mergeRef]);
  const result = spawnSync("bun", [join(import.meta.dir, "ci-refs.ts")], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_BASE: refs.eventBase,
      EVENT_HEAD: refs.mergeHead,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: refs.mergeRef,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`base=${refs.actualMain}`);
  expect(result.stdout).toContain(`head=${refs.mergeHead}`);
  expect(result.stdout).toContain("event_base_mismatch=true");
  expect(result.stderr).toContain("event BASE differs");
});

test("stale PR BASE is recorded but resolved parent 1 drives both selectors and version guard", () => {
  const result = resolve("pull_request", refs.mergeRef, refs.eventBase, refs.mergeHead);
  expect(result).toEqual({ base: refs.actualMain, eventBaseMismatch: true, head: refs.mergeHead });
  expect(() => verifyFeatureVersions(refs.eventBase, refs.mergeHead, fixture)).toThrow(
    "Feature PR changes version records",
  );
  expect(verifyFeatureVersions(result.base, result.head, fixture)).toHaveLength(2);
  expect(select(result.base, result.head)).toContain("rust=false");
});

test("a real feature version change still fails against verified merge parent 1", () => {
  git(["checkout", "--detach", "-q", refs.versionMergeRef]);
  const versionBase = git(["rev-parse", `${refs.versionMergeRef}^1`]);
  const result = resolve("pull_request", refs.versionMergeRef, versionBase, refs.versionHead);
  expect(result).toEqual({ base: versionBase, eventBaseMismatch: false, head: refs.versionHead });
  expect(() => verifyFeatureVersions(result.base, result.head, fixture)).toThrow(
    "Feature PR changes version records",
  );
});

test("wrong PR HEAD, non-merge checkout, and missing objects fail closed", () => {
  expect(() => resolve("pull_request", refs.actualMain, refs.eventBase, refs.mergeHead)).toThrow(
    "checkout HEAD",
  );
  git(["checkout", "--detach", "-q", refs.actualMain]);
  expect(() => resolve("pull_request", refs.actualMain, refs.eventBase, refs.actualMain)).toThrow(
    "exactly two merge parents",
  );
  git(["checkout", "--detach", "-q", refs.mergeRef]);
  expect(() => resolve("pull_request", refs.mergeRef, "f".repeat(40), refs.mergeHead)).toThrow(
    "Missing commit object",
  );
  expect(() => resolve("pull_request", refs.mergeRef, refs.eventBase, "short")).toThrow(
    "full commit ID",
  );
  expect(() => resolve("pull_request", refs.mergeRef, refs.eventBase, refs.actualMain)).toThrow(
    "event HEAD",
  );
});

test("push before-to-SHA semantics remain intact, including new-branch zero before", () => {
  git(["checkout", "--detach", "-q", refs.mergeRef]);
  expect(resolve("push", refs.mergeRef, refs.actualMain, refs.mergeRef)).toEqual({
    base: refs.actualMain,
    eventBaseMismatch: false,
    head: refs.mergeRef,
  });
  expect(resolve("push", refs.mergeRef, "0".repeat(40), refs.mergeRef)).toEqual({
    base: "0".repeat(40),
    eventBaseMismatch: false,
    head: refs.mergeRef,
  });
});

test("workflow uses the validated ref outputs and preserves gate exceptions", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  expect(workflow).toContain('run: bun scripts/ci-refs.ts >> "$GITHUB_OUTPUT"');
  expect(workflow).toContain("BASE: ${{ steps.refs.outputs.base }}");
  expect(workflow).toContain("HEAD: ${{ steps.refs.outputs.head }}");
  expect(workflow).toContain("!contains(github.event.pull_request.labels.*.name, 'release')");
  expect(workflow).toContain("!contains(github.event.pull_request.labels.*.name, 'consumer-pin')");
  expect(workflow).not.toContain("BASE: ${{ github.event.pull_request.base.sha }}");
  expect(workflow).not.toContain("HEAD: ${{ github.event.pull_request.head.sha }}");
});

test("manual branch CI compares the immutable checkout with main without a push payload", () => {
  git(["checkout", "--detach", "-q", refs.mergeHead]);
  git(["update-ref", "refs/remotes/origin/main", refs.actualMain]);
  expect(
    resolveComparisonRefs({
      cwd: fixture,
      eventName: "workflow_dispatch",
      eventBase: "",
      eventHead: "",
      githubSha: refs.mergeHead,
    }),
  ).toEqual({ base: refs.actualMain, eventBaseMismatch: false, head: refs.mergeHead });
  const result = spawnSync("bun", [join(import.meta.dir, "ci-refs.ts")], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SHA: refs.mergeHead,
      EVENT_BASE: "",
      EVENT_HEAD: refs.mergeHead,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`base=${refs.actualMain}`);
});
