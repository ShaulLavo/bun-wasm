import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";
import { discoverChecks } from "./test-checks";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ci-check-inputs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let serial = 0;

function repository() {
  const directory = join(scratch, String(serial++));
  mkdirSync(directory);
  function git(args: readonly string[]) {
    return execFileSync("git", ["-C", directory, "-c", "user.name=CI test", "-c", "user.email=ci@localhost"].concat(args), { encoding: "utf8" }).trim();
  }
  function write(path: string, value: string) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), value);
  }
  function commit() {
    git(["add", "-A"]);
    git(["commit", "-qm", "fixture"]);
    return git(["rev-parse", "HEAD"]);
  }
  function select(base: string, head: string, event: string) {
    const result = spawnSync("bun", [join(import.meta.dir, "ci-changes.ts"), base, head], {
      cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: event }, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return { output: result.stdout.trim(), inputs: result.stderr.trim() };
  }
  git(["init", "-q"]);
  write("base.txt", "fixture\n");
  return { directory, git, write, commit, select };
}

const compiledChecks = discoverChecks().filter(check => check.owner === "native" || check.owner === "runtime");
test.each(compiledChecks)("declared $owner check $path retains its blocking Rust owner", check => {
  const path = check.owner === "native" ? `${check.path}/index.ts` : check.path;
  expect(needsRust([path])).toBe(true);
});

for (const event of ["pull_request", "push"]) {
  for (const owner of ["native", "runtime"] as const) {
    const input = owner === "native" ? "tests/fixtures/new-owned-case/index.ts" : "scripts/new-owned-case.test.ts";
    const checkPath = owner === "native" ? "tests/fixtures/new-owned-case" : input;
    test(`${event} reads ${owner} check paths from the head snapshot`, () => {
      const repo = repository();
      const base = repo.commit();
      repo.write(`checks/${owner}-new-owned-case.json`, JSON.stringify({ owner, path: checkPath }));
      repo.write(input, "first\n");
      const registered = repo.commit();
      repo.write(input, "changed\n");
      expect(repo.select(registered, repo.commit(), event).output).toBe("rust=true\njsc=false");
      expect(repo.select(base, registered, event).output).toBe("rust=true\njsc=false");
    });
    test(`${event} reads removed ${owner} check paths from the base snapshot`, () => {
      const repo = repository();
      repo.write(`checks/${owner}-new-owned-case.json`, JSON.stringify({ owner, path: checkPath }));
      repo.write(input, "first\n");
      const base = repo.commit();
      rmSync(join(repo.directory, input));
      repo.git(["mv", `checks/${owner}-new-owned-case.json`, `checks/web-new-owned-case.json`]);
      repo.write("checks/web-new-owned-case.json", JSON.stringify({ owner: "web", path: "scripts/replacement.test.ts", localRuntime: true }));
      repo.write("scripts/replacement.test.ts", "replacement\n");
      const selected = repo.select(base, repo.commit(), event);
      expect(selected.output).toBe("rust=true\njsc=false");
      expect(selected.inputs).toContain(input);
    });
  }
  test(`${event} keeps source-only Web registration and edits outside the native job`, () => {
    const repo = repository();
    const base = repo.commit();
    repo.write("checks/web-context-reference.json", JSON.stringify({ owner: "web", path: "scripts/context-reference.test.ts", localRuntime: true }));
    repo.write("scripts/context-reference.test.ts", "Node reference\n");
    const registered = repo.commit();
    expect(repo.select(base, registered, event).output).toBe("rust=false\njsc=false");
    repo.write("scripts/context-reference.test.ts", "edited Node reference\n");
    expect(repo.select(registered, repo.commit(), event).output).toBe("rust=false\njsc=false");
  });
}

test("deleted native ownership still gates a renamed input in a later PR commit", () => {
  const repo = repository();
  repo.write("checks/runtime-old-harness.json", JSON.stringify({ owner: "runtime", path: "scripts/old-harness.test.ts" }));
  repo.write("scripts/old-harness.test.ts", "Rust harness\n");
  const base = repo.commit();
  rmSync(join(repo.directory, "checks/runtime-old-harness.json"));
  repo.commit();
  repo.git(["mv", "scripts/old-harness.test.ts", "scripts/source-only.test.ts"]);
  const selected = repo.select(base, repo.commit(), "pull_request");
  expect(selected.output).toBe("rust=true\njsc=false");
  expect(selected.inputs).toContain("scripts/old-harness.test.ts");
});

test.each([
  "crates/bunwasm-runtime/src/js/process.ts", "crates/bunwasm-runtime/src/host.rs",
  "web/src/engine-host.js", "web/scripts/node-host.ts", "web/src/native-direct-stream.ts",
])("actual runtime and host glue %s still selects Rust and JSC", path => {
  expect(needsRust([path])).toBe(true);
  expect(needsJsc([path])).toBe(true);
});

for (const event of ["pull_request", "push"]) {
  test(`${event} reads the old and new paths when a runtime manifest changes its harness`, () => {
    const repo = repository();
    repo.write("checks/runtime-moved.json", JSON.stringify({ owner: "runtime", path: "scripts/old.test.ts" }));
    repo.write("scripts/old.test.ts", "before\n");
    const base = repo.commit();
    repo.write("checks/runtime-moved.json", JSON.stringify({ owner: "runtime", path: "scripts/new.test.ts" }));
    repo.git(["mv", "scripts/old.test.ts", "scripts/new.test.ts"]);
    const selected = repo.select(base, repo.commit(), event);
    expect(selected.output).toBe("rust=true\njsc=false");
    expect(selected.inputs).toContain("scripts/old.test.ts");
    expect(selected.inputs).toContain("scripts/new.test.ts");
  });
}

test("a diverged PR reads metadata at the diff's merge base", () => {
  const repo = repository();
  repo.write("checks/runtime-old.json", JSON.stringify({ owner: "runtime", path: "scripts/old.test.ts" }));
  repo.write("scripts/old.test.ts", "before\n");
  const base = repo.commit();
  repo.git(["checkout", "-qb", "target"]);
  rmSync(join(repo.directory, "checks/runtime-old.json"));
  const target = repo.commit();
  repo.git(["checkout", "--detach", base]);
  repo.write("scripts/old.test.ts", "changed on PR\n");
  expect(repo.select(target, repo.commit(), "pull_request").inputs).toContain("scripts/old.test.ts");
});

test.each(["base", "head"])("invalid %s check metadata fails closed", side => {
  const repo = repository();
  repo.write("checks/runtime-harness.json", JSON.stringify({ owner: "unknown", path: "scripts/harness.test.ts" }));
  const invalid = repo.commit();
  repo.write("checks/runtime-harness.json", JSON.stringify({ owner: "runtime", path: "scripts/harness.test.ts" }));
  const valid = repo.commit();
  expect(() => repo.select(side === "base" ? invalid : valid, side === "head" ? invalid : valid, "push")).toThrow("Unknown check owner");
});

test("selector helper changes retain both engine gates", () => {
  expect(needsRust(["scripts/ci-check-inputs.ts"])).toBe(true);
  expect(needsJsc(["scripts/ci-check-inputs.ts"])).toBe(true);
});
