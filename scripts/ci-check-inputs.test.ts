import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";
import { discoverChecks } from "./test-checks";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ci-check-inputs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let serial = 0;

function repository() {
  const directory = join(scratch, String(serial++));
  mkdirSync(directory);
  function git(args: readonly string[]) {
    return execFileSync("git", ["-C", directory, "-c", "user.name=CI test", "-c", "user.email=ci@localhost"].concat(args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  function select(base: string, head: string, event: string, families = false) {
    const script = join(import.meta.dir, "ci-changes.ts");
    const args = families ? ["--eval", `import { selectChanges, selectionOutput } from ${JSON.stringify(script)}; console.log(selectionOutput(selectChanges(${JSON.stringify(base)}, ${JSON.stringify(head)}, ${event === "pull_request"})));`] : [script, base, head];
    const result = spawnSync("bun", args, {
      cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: event }, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return { output: result.stdout.trim().split("\n").slice(0, 3).join("\n"), profile: result.stdout.trim().split("\n")[3], inputs: result.stderr.trim(), browser: result.stdout.trim().split("\n")[4] };
  }
  git(["init", "-q"]);
  write("base.txt", "fixture\n");
  return { directory, git, write, commit, select };
}

for (const event of ["pull_request", "push"]) {
  test(`${event} a Browser-only native fixture does not compile JSC`, () => {
    const repo = repository();
    const input = "tests/fixtures/browser-engine-case/index.ts";
    repo.write("checks/native-browser-engine-case.json", JSON.stringify({ owner: "native", path: "tests/fixtures/browser-engine-case", engines: ["browser"] }));
    repo.write(input, "before\n");
    const base = repo.commit();
    repo.write(input, "after\n");
    expect(repo.select(base, repo.commit(), event).output).toBe("rust=true\njsc=false\nshared=false");
  });
}

const compiledChecks = discoverChecks().filter(check => check.owner === "native" || check.owner === "runtime" || check.owner === "browser-guest");

const legacyManifest = "checks/runtime-legacy-cli.json";
const legacyCheck = discoverChecks().find(check => check.path === "scripts/legacy-cli-runtime.test.ts");
if (legacyCheck?.owner !== "runtime") throw new Error("Missing legacy CLI runtime owner");
for (const event of ["pull_request", "push"]) test.each(legacyCheck.inputs)(`${event} selects legacy CLI coverage for %s alone`, input => {
  const repo = repository();
  repo.write(legacyManifest, readFileSync(join(import.meta.dir, "..", legacyManifest), "utf8"));
  repo.write(input, "original source\n");
  const base = repo.commit();
  repo.write(input, "changed source\n");
  const selected = repo.select(base, repo.commit(), event);
  expect(selected.output.startsWith("rust=true\n")).toBe(true);
  expect(selected.inputs).toContain(input);
});

for (const event of ["pull_request", "push"]) {
  test(`${event} preserves JSC production for declared engine fixtures through edits and removal`, () => {
    const repo = repository();
    const manifest = "checks/native-engine-case.json";
    const input = "tests/fixtures/engine-case/index.ts";
    repo.write(manifest, JSON.stringify({ owner: "native", path: "tests/fixtures/engine-case", engines: ["quickjs", "jsc", "browser"] }));
    repo.write(input, "before\n");
    const registered = repo.commit();
    repo.write(input, "after\n");
    const changed = repo.commit();
    expect(repo.select(registered, changed, event).output).toBe("rust=true\njsc=true\nshared=false");
    repo.git(["rm", manifest, input]);
    expect(repo.select(changed, repo.commit(), event).output).toBe("rust=true\njsc=true\nshared=false");
  });
}
test.each(compiledChecks)("declared $owner check $path retains its blocking Rust owner", check => {
  const path = check.owner === "native" ? `${check.path}/index.ts` : check.path;
  expect(needsRust([path])).toBe(true);
});

for (const event of ["pull_request", "push"]) {
  test(`${event} retains JSC selection for declared native engines and removed targets`, () => {
    const repo = repository();
    const base = repo.commit();
    const manifest = "checks/native-matrix.json";
    const input = "tests/fixtures/new-matrix/index.ts";
    repo.write(manifest, JSON.stringify({ owner: "native", path: "tests/fixtures/new-matrix", engines: ["quickjs", "jsc", "spidermonkey"] }));
    repo.write(input, "before\n");
    const registered = repo.commit();
    expect(repo.select(base, registered, event).output).toBe("rust=true\njsc=true\nshared=false");
    repo.write(input, "changed\n");
    const changed = repo.commit();
    expect(repo.select(registered, changed, event).output).toBe("rust=true\njsc=true\nshared=false");
    repo.write(manifest, JSON.stringify({ owner: "native", path: "tests/fixtures/new-matrix" }));
    expect(repo.select(changed, repo.commit(), event).output).toBe("rust=true\njsc=true\nshared=false");
  });
  for (const owner of ["native", "runtime", "browser-guest"] as const) {
    const input = owner === "native" ? "tests/fixtures/new-owned-case/index.ts" : "scripts/new-owned-case.test.ts";
    const checkPath = owner === "native" ? "tests/fixtures/new-owned-case" : input;
    test(`${event} reads ${owner} check paths from the head snapshot`, () => {
      const repo = repository();
      const base = repo.commit();
      repo.write(`checks/${owner}-new-owned-case.json`, JSON.stringify({ owner, path: checkPath }));
      repo.write(input, "first\n");
      const registered = repo.commit();
      repo.write(input, "changed\n");
      expect(repo.select(registered, repo.commit(), event).output).toBe(`rust=${owner !== "browser-guest"}\njsc=false\nshared=false`);
      expect(repo.select(base, registered, event).output).toBe(`rust=${owner !== "browser-guest"}\njsc=false\nshared=false`);
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
      expect(selected.output).toBe(`rust=${owner !== "browser-guest"}\njsc=false\nshared=false`);
      if (owner !== "browser-guest") expect(selected.inputs).toContain(input);
    });
  }
  test(`${event} keeps source-only Web registration and edits outside the native job`, () => {
    const repo = repository();
    const base = repo.commit();
    repo.write("checks/web-context-reference.json", JSON.stringify({ owner: "web", path: "scripts/context-reference.test.ts", localRuntime: true }));
    repo.write("scripts/context-reference.test.ts", "Node reference\n");
    const registered = repo.commit();
    expect(repo.select(base, registered, event).output).toBe("rust=false\njsc=false\nshared=false");
    repo.write("scripts/context-reference.test.ts", "edited Node reference\n");
    expect(repo.select(registered, repo.commit(), event).output).toBe("rust=false\njsc=false\nshared=false");
  });
}

const largeMessageManifest = "checks/browser-guest-worker-large-message.json";
const largeMessageHarness = "scripts/worker-large-message-browser.test.ts";
const largeMessageSources = [
  "web/src/shared-objects/broker.ts", "web/src/shared-objects/lane-overflow.ts",
  "web/src/shared-objects/lane.ts", "web/src/shared-objects/protocol.ts", "web/src/shared-objects/service.ts",
];

for (const event of ["pull_request", "push"]) {
  test.each([largeMessageHarness, largeMessageManifest].concat(largeMessageSources))(`${event} selects the real large-message gate for %s alone`, path => {
    const repo = repository();
    repo.write(largeMessageManifest, readFileSync(join(import.meta.dir, "..", largeMessageManifest), "utf8"));
    for (const input of [largeMessageHarness].concat(largeMessageSources)) repo.write(input, "before\n");
    const base = repo.commit();
    repo.write(path, path === largeMessageManifest ? `${readFileSync(join(repo.directory, path), "utf8")}\n` : "changed\n");
    const selected = repo.select(base, repo.commit(), event);
    expect(selected.output).toBe(`rust=${false}\njsc=false\nshared=false`);
    expect(selected.profile).toBe("shared_native=false");
    expect(selected.browser).toBe("browser_guest=true");
    expect(selected.inputs).toBe("Native inputs changed: none");
  });

  test.each(["split", "shared-group"] as const)(`${event} retains removed %s Browser guest secondary inputs`, profile => {
    const repo = repository();
    const manifest = "checks/browser-guest-secondary.json";
    const input = "web/src/secondary-input.ts";
    repo.write(manifest, JSON.stringify({ owner: "browser-guest", path: "scripts/secondary.test.ts", profile, inputs: [input] }));
    repo.write(input, "before\n");
    const base = repo.commit();
    repo.write(input, "changed\n");
    const changed = repo.commit();
    const selectedChange = repo.select(base, changed, event);
    expect(selectedChange.output).toBe(`rust=${profile === "shared-group"}\njsc=false\nshared=false`);
    expect(selectedChange.profile).toBe(`shared_native=${profile === "shared-group"}`);
    rmSync(join(repo.directory, manifest));
    rmSync(join(repo.directory, input));
    const selected = repo.select(changed, repo.commit(), event);
    expect(selected.output).toBe(`rust=${profile === "shared-group"}\njsc=false\nshared=false`);
    expect(selected.profile).toBe(`shared_native=${profile === "shared-group"}`);
    if (profile === "shared-group") expect(selected.inputs).toContain(input);
  });

  test(`${event} reads a fixture's second command from the snapshot that declares it, added or deleted`, () => {
    const repo = repository();
    const path = "tests/fixtures/shared-pair";
    const manifest = "checks/native-shared-pair-lifetime.json";
    repo.write("checks/native-shared-pair.json", JSON.stringify({ owner: "native", path, profile: "shared-group" }));
    for (const name of ["cmd", "expected.txt", "cmd.lifetime", "expected.lifetime.txt", "lifetime.ts"]) repo.write(`${path}/${name}`, "before\n");
    const base = repo.commit();
    // Added: the head snapshot declares the entry, and the same schema reads it.
    repo.write(manifest, JSON.stringify({ owner: "native", path, profile: "shared-group", entry: "lifetime" }));
    const added = repo.commit();
    const addition = repo.select(base, added, event);
    expect(addition.profile).toBe("shared_native=true");
    expect(addition.inputs).toContain(manifest);
    // An edit to a file only the second command runs selects the shared producer.
    repo.write(`${path}/lifetime.ts`, "changed\n");
    const edited = repo.commit();
    expect(repo.select(added, edited, event).profile).toBe("shared_native=true");
    // Deleted: the base snapshot still declares it.
    rmSync(join(repo.directory, manifest));
    const removal = repo.select(edited, repo.commit(), event);
    expect(removal.profile).toBe("shared_native=true");
    expect(removal.inputs).toContain(manifest);
  });

  test(`${event} keeps unrelated Web source and docs outside the Browser guest producer`, () => {
    const repo = repository();
    repo.write(largeMessageManifest, readFileSync(join(import.meta.dir, "..", largeMessageManifest), "utf8"));
    repo.write("checks/web-source-only.json", JSON.stringify({ owner: "web", path: "scripts/source-only.test.ts", localRuntime: true }));
    const base = repo.commit();
    repo.write("web/src/unrelated.ts", "source-only UI\n");
    repo.write("scripts/source-only.test.ts", "source-only check\n");
    repo.write("docs/unrelated.md", "docs\n");
    const selected = repo.select(base, repo.commit(), event);
    expect(selected.output).toBe("rust=false\njsc=false\nshared=false");
    expect(selected.profile).toBe("shared_native=false");
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
  expect(selected.output).toBe("rust=true\njsc=false\nshared=false");
  expect(selected.inputs).toContain("scripts/old-harness.test.ts");
});

test.each([
  "crates/bunwasm-runtime/src/js/process.ts", "crates/bunwasm-runtime/src/host.rs",
  "web/src/engine-host.js", "web/scripts/node-host.ts", "web/src/native-direct-stream.ts", "web/src/native-readable-iterator.ts",
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
    expect(selected.output).toBe("rust=true\njsc=false\nshared=false");
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


test("a diverged PR preserves compiled ownership introduced by the verified tested base", () => {
  const repo = repository();
  const path = "scripts/target-owned.test.ts";
  repo.write("checks/web-target-owned.json", JSON.stringify({ owner: "web", path }));
  repo.write(path, "before\n");
  const ancestor = repo.commit();
  repo.git(["checkout", "-qb", "target"]);
  repo.git(["mv", "checks/web-target-owned.json", "checks/runtime-target-owned.json"]);
  repo.write("checks/runtime-target-owned.json", JSON.stringify({ owner: "runtime", path }));
  const verifiedBase = repo.commit();
  repo.git(["checkout", "--detach", ancestor]);
  repo.write(path, "changed on PR\n");
  const head = repo.commit();
  repo.git(["checkout", "target"]);
  repo.git(["merge", "--no-ff", "--no-edit", head]);
  expect(JSON.parse(readFileSync(join(repo.directory, "checks/runtime-target-owned.json"), "utf8")).owner).toBe("runtime");
  const selected = repo.select(verifiedBase, head, "pull_request");
  expect(selected.output).toBe("rust=true\njsc=false\nshared=false");
  expect(selected.inputs).toBe(`Native inputs changed: ${path}`);
});

const unsafeSnapshots = ["empty", "symlink"].flatMap(kind => ["base", "head"].flatMap(side =>
  ["pull_request", "push"].map(event => ({ kind, side, event }))));

test.each(unsafeSnapshots)("$event rejects $kind manifests in the $side snapshot", ({ kind, side, event }) => {
  const repo = repository();
  repo.write("checks/web-control.json", JSON.stringify({ owner: "web", path: "scripts/control.test.ts" }));
  repo.write("scripts/control.test.ts", "valid source-only test\n");
  const clean = repo.commit();
  const path = "checks/web-invalid.json";
  if (kind === "empty") repo.write(path, "");
  if (kind === "symlink") symlinkSync("web-control.json", join(repo.directory, path));
  const invalid = repo.commit();
  rmSync(join(repo.directory, path));
  const repaired = repo.commit();
  expect(() => repo.select(side === "base" ? invalid : clean, side === "base" ? repaired : invalid, event)).toThrow();
});

for (const event of ["pull_request", "push"]) for (const owner of ["native-probe", "runtime"]) test(`${event} retains ${owner} secondary and deleted inputs`, () => {
  const repo = repository();
  const manifest = `checks/${owner}-fixture.json`;
  repo.write(manifest, JSON.stringify({ owner, path: "scripts/fixture-live.test.ts", inputs: ["scripts/fixture-byte-driver.ts"] }));
  repo.write("scripts/fixture-live.test.ts", "live source fixture\n");
  repo.write("scripts/fixture-byte-driver.ts", "original fixture\n");
  const base = repo.commit();
  repo.write("scripts/fixture-byte-driver.ts", "changed fixture\n");
  const changed = repo.commit();
  expect(repo.select(base, changed, event).output).toBe("rust=true\njsc=false\nshared=false");
  rmSync(join(repo.directory, manifest));
  rmSync(join(repo.directory, "scripts/fixture-byte-driver.ts"));
  const deleted = repo.commit();
  expect(repo.select(changed, deleted, event).output).toBe("rust=true\njsc=false\nshared=false");
});

test.each(["native-probe", "runtime"])("diverged %s deletion still selects secondary inputs from its merge ancestor", owner => {
  const repo = repository();
  const manifest = `checks/${owner}-ancestor.json`;
  repo.write(manifest, JSON.stringify({ owner, path: "scripts/fixture-live.test.ts", inputs: ["scripts/fixture-ancestor-driver.ts"] }));
  repo.write("scripts/fixture-live.test.ts", "synthetic live check\n");
  repo.write("scripts/fixture-ancestor-driver.ts", "before\n");
  const ancestor = repo.commit();
  repo.git(["checkout", "-qb", "target"]);
  repo.write("target-only.txt", "force a distinct merge-ancestor fixture\n");
  rmSync(join(repo.directory, manifest));
  const base = repo.commit();
  repo.git(["checkout", "--detach", ancestor]);
  rmSync(join(repo.directory, manifest));
  repo.commit();
  repo.write("scripts/fixture-ancestor-driver.ts", "changed after both sides dropped metadata\n");
  const head = repo.commit();
  expect(repo.git(["merge-base", base, head])).toBe(ancestor);
  const selected = repo.select(base, head, "pull_request");
  expect(selected.output).toBe("rust=true\njsc=false\nshared=false");
  expect(selected.inputs).toContain("scripts/fixture-ancestor-driver.ts");
});

for (const event of ["pull_request", "push"]) test(`${event} selects shared profiles from introduced and removed metadata`, () => {
  const repo = repository();
  const base = repo.commit();
  const manifest = "checks/native-group.json";
  const input = "tests/fixtures/group-only/guest.ts";
  repo.write(manifest, JSON.stringify({ owner: "native", path: "tests/fixtures/group-only", profile: "shared-group" }));
  repo.write(input, "group fixture\n");
  const registered = repo.commit();
  expect(repo.select(base, registered, event).profile).toBe("shared_native=true");
  repo.write(input, "changed group fixture\n");
  const changed = repo.commit();
  expect(repo.select(registered, changed, event).profile).toBe("shared_native=true");
  rmSync(join(repo.directory, manifest));
  rmSync(join(repo.directory, input));
  expect(repo.select(changed, repo.commit(), event).profile).toBe("shared_native=true");
});

function familyOutput(repo: ReturnType<typeof repository>, base: string, head: string, event = "pull_request"): string {
  const selected = repo.select(base, head, event, true);
  return [selected.output, selected.profile, selected.browser].join("\n");
}

const browserFamily = "rust=false\njsc=false\nshared=false\nshared_native=false\nbrowser_guest=true";
const nativeFamily = "rust=true\njsc=false\nshared=false\nshared_native=false\nbrowser_guest=true";
const noFamily = "rust=false\njsc=false\nshared=false\nshared_native=false\nbrowser_guest=false";

function storageRepository() {
  const repo = repository();
  repo.write("checks/browser-guest-sandbox-storage.json", readFileSync(join(import.meta.dir, "../checks/browser-guest-sandbox-storage.json"), "utf8"));
  return repo;
}

const pr819Paths = ["sandbox/template-next/next.config.ts", "scripts/next-build-scheduling.test.ts", "docs/bun-patches/next-build-scheduling.md"];

test("exact PR 819 and Storage-only inputs select fresh Browser production through the live selector", () => {
  for (const paths of [pr819Paths, [pr819Paths[0]!]]) {
    const repo = storageRepository();
    const base = repo.commit();
    for (const path of paths) repo.write(path, "PR 819 change\n");
    const head = repo.commit();
    expect(familyOutput(repo, base, head)).toBe(browserFamily);
    expect(repo.select(base, head, "pull_request").output).toBe("rust=false\njsc=false\nshared=false");
    expect(repo.select(base, head, "pull_request").browser).toBe("browser_guest=true");
    for (const event of ["push", "workflow_dispatch"]) expect(familyOutput(repo, base, head, event)).toBe(browserFamily);
  }
});

test.each([
  "crates/bunwasm-runtime/src/host.rs", "web/src/native-direct-stream.ts", "web/src/bun-launcher.ts",
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "env.sh", "bun.lock", ".github/workflows/ci.yml",
  "scripts/build-unclassified.sh", ".github/actions/shared-jsc-setup/action.yml",
])("independent native cause %s overrides ordinary Browser ownership", path => {
  const repo = storageRepository();
  repo.write("checks/browser-guest-overlap.json", JSON.stringify({ owner: "browser-guest", path: "scripts/overlap.test.ts", inputs: [path] }));
  const base = repo.commit();
  repo.write(path, "native input\n");
  const head = repo.commit();
  const selected = repo.select(base, head, "pull_request", true);
  expect(selected.output).toStartWith("rust=true\n");
  expect(selected.browser).toBe("browser_guest=true");
  expect(selected.output).toBe(repo.select(base, head, "pull_request").output);
  expect(selected.profile).toBe(repo.select(base, head, "pull_request").profile);
});

test.each(["native", "runtime", "native-probe"] as const)("dual Browser and %s declarations retain independent native correctness", owner => {
  const repo = repository();
  const input = owner === "native" ? "tests/fixtures/dual/guest.ts" : "scripts/dual.test.ts";
  repo.write("checks/browser-guest-dual.json", JSON.stringify({ owner: "browser-guest", path: "scripts/browser-dual.test.ts", inputs: [input] }));
  repo.write(`checks/${owner}-dual.json`, JSON.stringify({ owner, path: owner === "native" ? "tests/fixtures/dual" : input, ...(owner === "native-probe" ? { inputs: ["scripts/secondary.ts"] } : {}) }));
  const base = repo.commit();
  repo.write(input, "dual-owned change\n");
  expect(familyOutput(repo, base, repo.commit())).toBe(nativeFamily);
});

test.each(["quickjs", "browser", "spidermonkey", "jsc"])("native engine %s preserves its own JSC selection without global expansion", engine => {
  const repo = repository();
  repo.write("checks/native-engine-selection.json", JSON.stringify({ owner: "native", path: "tests/fixtures/engine-selection", engines: [engine] }));
  const base = repo.commit();
  repo.write("tests/fixtures/engine-selection/expected.txt", "expected output\n");
  const selected = repo.select(base, repo.commit(), "pull_request", true);
  expect(selected.output).toBe(`rust=true\njsc=${engine === "jsc"}\nshared=false`);
  expect(selected.browser).toBe("browser_guest=true");
});

test("shared Browser ownership always keeps the full shared native route", () => {
  const repo = repository();
  repo.write("checks/browser-guest-group.json", JSON.stringify({ owner: "browser-guest", path: "scripts/group.test.ts", inputs: ["web/src/group.ts"], profile: "shared-group" }));
  const base = repo.commit();
  repo.write("web/src/group.ts", "group input\n");
  expect(familyOutput(repo, base, repo.commit())).toBe("rust=true\njsc=false\nshared=false\nshared_native=true\nbrowser_guest=true");
});

test.each(["split", "shared-group"] as const)("%s Browser declarations retain introduction, edits, renames and removals", profile => {
  const repo = repository();
  const manifest = "checks/browser-guest-lifecycle.json";
  const input = "web/src/lifecycle.ts";
  const expected = profile === "split" ? browserFamily : "rust=true\njsc=false\nshared=false\nshared_native=true\nbrowser_guest=true";
  const base = repo.commit();
  repo.write(manifest, JSON.stringify({ owner: "browser-guest", path: "scripts/lifecycle.test.ts", inputs: [input], ...(profile === "shared-group" ? { profile } : {}) }));
  repo.write(input, "before\n");
  const introduced = repo.commit();
  expect(familyOutput(repo, base, introduced)).toBe(expected);
  repo.write(input, "edited\n");
  const edited = repo.commit();
  expect(familyOutput(repo, introduced, edited)).toBe(expected);
  repo.git(["mv", input, "web/src/lifecycle-renamed.ts"]);
  repo.write(manifest, JSON.stringify({ owner: "browser-guest", path: "scripts/lifecycle.test.ts", inputs: ["web/src/lifecycle-renamed.ts"], ...(profile === "shared-group" ? { profile } : {}) }));
  const renamed = repo.commit();
  expect(familyOutput(repo, edited, renamed)).toBe(expected);
  const renamedManifest = "checks/browser-guest-lifecycle-renamed.json";
  repo.git(["mv", manifest, renamedManifest]);
  const manifestMoved = repo.commit();
  expect(familyOutput(repo, renamed, manifestMoved)).toBe(expected);
  repo.git(["rm", renamedManifest, "web/src/lifecycle-renamed.ts"]);
  expect(familyOutput(repo, manifestMoved, repo.commit())).toBe(expected);
});

test.each(["browser-guest", "runtime", "native-probe"] as const)("ancestor-only %s ownership survives deletion on both PR branches", owner => {
  const repo = repository();
  const manifest = `checks/${owner}-ancestor-family.json`;
  const input = "scripts/ancestor-family.ts";
  repo.write(manifest, JSON.stringify({ owner, path: "scripts/ancestor-family.test.ts", ...(owner === "runtime" ? {} : { inputs: [input] }) }));
  const owned = owner === "runtime" ? "scripts/ancestor-family.test.ts" : input;
  repo.write(owned, "before\n");
  const ancestor = repo.commit();
  repo.git(["checkout", "-qb", "target"]);
  repo.git(["rm", manifest]);
  repo.write("target.txt", "target\n");
  const base = repo.commit();
  repo.git(["checkout", "--detach", ancestor]);
  repo.git(["rm", manifest]);
  repo.write(owned, "changed after deletion\n");
  const head = repo.commit();
  expect(repo.git(["merge-base", base, head])).toBe(ancestor);
  expect(familyOutput(repo, base, head)).toBe(owner === "browser-guest" ? browserFamily : nativeFamily);
});

test.each(["base", "head", "ancestor"])("the additive API rejects malformed or unsafe %s snapshots even outside the selected family", side => {
  const repo = repository();
  repo.write("checks/quality-invalid.json", "");
  const invalid = repo.commit();
  repo.git(["rm", "checks/quality-invalid.json"]);
  repo.write("target.txt", "target\n");
  const base = repo.commit();
  repo.git(["checkout", "--detach", invalid]);
  repo.git(["rm", "checks/quality-invalid.json"]);
  repo.write("head.txt", "head\n");
  const head = repo.commit();
  expect(() => familyOutput(repo, side === "base" ? invalid : base, side === "head" ? invalid : head)).toThrow();
});

test("missing comparison history fails closed and the initial-push fallback keeps native production", () => {
  const repo = repository();
  const head = repo.commit();
  expect(familyOutput(repo, "0".repeat(40), head, "push")).toContain("rust=true\n");
  expect(() => familyOutput(repo, "1".repeat(40), head)).toThrow();
});

test("unrelated UI, docs and source-only Web/quality checks select no producer family", () => {
  const repo = storageRepository();
  repo.write("checks/web-source-only-family.json", JSON.stringify({ owner: "web", path: "scripts/source-only-family.test.ts", localRuntime: true }));
  repo.write("checks/quality-source-only-family.json", JSON.stringify({ owner: "quality", path: "scripts/source-only-quality.test.ts" }));
  const base = repo.commit();
  for (const path of ["web/src/unrelated-ui.ts", "docs/unrelated.md", "scripts/source-only-family.test.ts", "scripts/source-only-quality.test.ts"]) repo.write(path, "source-only change\n");
  expect(familyOutput(repo, base, repo.commit())).toBe(noFamily);
});

test("version-only package edits preserve the live native exception while real package edits retain it", () => {
  const repo = repository();
  repo.write("package.json", JSON.stringify({ version: "0.0.1", scripts: { check: "original" } }));
  const base = repo.commit();
  repo.write("package.json", JSON.stringify({ version: "0.0.2", scripts: { check: "original" } }));
  const version = repo.commit();
  expect(repo.select(base, version, "pull_request", true).output).toBe(repo.select(base, version, "pull_request").output);
  expect(repo.select(base, version, "pull_request", true).output).toStartWith("rust=false\n");
  repo.write("package.json", JSON.stringify({ version: "0.0.2", scripts: { check: "changed" } }));
  expect(repo.select(version, repo.commit(), "pull_request", true).output).toStartWith("rust=true\n");
});

test("family filtering never suppresses an unsafe manifest or check directory", () => {
  const repo = repository();
  repo.write("checks/quality-control.json", JSON.stringify({ owner: "quality", path: "scripts/control.test.ts" }));
  const base = repo.commit();
  symlinkSync("quality-control.json", join(repo.directory, "checks/browser-guest-unsafe.json"));
  const unsafeManifest = repo.commit();
  expect(() => familyOutput(repo, base, unsafeManifest)).toThrow("Unsafe check manifest");
  repo.git(["rm", "-r", "checks"]);
  symlinkSync("elsewhere", join(repo.directory, "checks"));
  expect(() => familyOutput(repo, base, repo.commit())).toThrow("Unsafe check directory");
});

test.each(["native", "runtime", "native-probe"] as const)("introduced and removed %s declarations retain native routing until the next comparison", owner => {
  const repo = repository();
  const input = owner === "native" ? "tests/fixtures/family-transition/guest.ts" : "scripts/family-transition.test.ts";
  const manifest = `checks/${owner}-family-transition.json`;
  const base = repo.commit();
  repo.write(manifest, JSON.stringify({ owner, path: owner === "native" ? "tests/fixtures/family-transition" : input, ...(owner === "native-probe" ? { inputs: ["scripts/family-transition-helper.ts"] } : {}) }));
  repo.write("checks/browser-guest-family-transition.json", JSON.stringify({ owner: "browser-guest", path: "scripts/browser-family-transition.test.ts", inputs: [input] }));
  repo.write(input, "introduced\n");
  const introduced = repo.commit();
  expect(familyOutput(repo, base, introduced)).toBe(nativeFamily);
  repo.git(["rm", manifest]);
  const removed = repo.commit();
  expect(familyOutput(repo, introduced, removed)).toBe(nativeFamily);
  repo.write(input, "ordinary Browser ownership only\n");
  expect(familyOutput(repo, removed, repo.commit())).toBe(browserFamily);
});

test.each(["native-setup", "native-seed", "native-production"])("shared action %s selects every native, JSC and shared consumer through edit, rename and removal", action => {
  const repo = repository();
  repo.write("checks/native-shared-action-control.json", JSON.stringify({ owner: "native", path: "tests/fixtures/shared-action-control", profile: "shared-group" }));
  const path = `.github/actions/${action}/action.yml`;
  const base = repo.commit();
  repo.write(path, "introduced\n");
  const introduced = repo.commit();
  const full = "rust=true\njsc=true\nshared=true\nshared_native=true\nbrowser_guest=true";
  expect(familyOutput(repo, base, introduced)).toBe(full);
  repo.write(path, "edited\n");
  const edited = repo.commit();
  expect(familyOutput(repo, introduced, edited)).toBe(full);
  repo.git(["mv", path, `${path}.moved`]);
  const renamed = repo.commit();
  expect(familyOutput(repo, edited, renamed)).toBe(full);
  repo.git(["mv", `${path}.moved`, path]);
  const restored = repo.commit();
  repo.git(["rm", path]);
  expect(familyOutput(repo, restored, repo.commit())).toBe(full);
});
