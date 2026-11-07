import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testSubreaper } from "../test-subreaper.ts";
import { ProcessOwner } from "../process-owner.mts";
import { handoffMemberPaths } from "../producer-closure.ts";
import { SYSROOT_PROBE, Staging, environmentDifferences, nativeWitness, requireCanonicalBuildTools, requireNativeEntry, requireStagedWaffle } from "./admission.ts";
import { FIXTURE_SOURCE, FIXTURE_TUPLE } from "./contract-fixture.ts";
import { sha256 } from "./identity.ts";
import { AdmissionError, admitWebkit } from "./inputs.ts";
import { Invocation, operationSucceeded, rehearse, treeWitness, type Cleanup } from "./operations.ts";
import { publicationMatrix, restage, smokeInputs, verifyMatrixScratch } from "./publication.ts";
import { STAGES, blockReason, runStages, validateStages, type Stage, type StageContext } from "./stages.ts";

const repository = realpathSync(join(import.meta.dir, "../.."));
let scratch = "";
let restoreSubreaper = () => {};
beforeAll(async () => {
  restoreSubreaper = await testSubreaper(true);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "bun-wasm-c1-controller-")));
});
afterAll(() => {
  try {
    execFileSync("/usr/bin/chmod", ["-R", "u+w", scratch]);
    rmSync(scratch, { recursive: true, force: true });
  } finally { restoreSubreaper(); }
});
function fresh(name: string): string {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  return path;
}
function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}
/** env -0 of a bash that sources the given scripts in the real checkout. */
function sourcedEnv(env: Record<string, string>, script: string): Record<string, string> {
  const output = execFileSync("/usr/bin/bash", ["-c", `set -euo pipefail\n${script}\nenv -0`], { cwd: repository, env, encoding: "utf8" });
  return Object.fromEntries(output.split("\0").filter(Boolean).map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
}
function base(root: string, canonical: string): Record<string, string> {
  return { PATH: `${canonical}:/usr/bin:/bin`, HOME: root, WASM_TOOLS: join(root, "tools"), CARGO_HOME: join(root, "cargo"), RUSTUP_HOME: join(root, "rustup"),
    WASI_SDK_PATH: join(root, "sdk"), BUN_WASM_SYSROOT: join(root, "sysroot"), CARGO_TARGET_DIR: join(root, "targets"), TMPDIR: join(root, "t"), PLAYWRIGHT_BROWSERS_PATH: join(root, "pw") };
}
function canonicalTools(root: string): string {
  const bin = join(root, "canonical");
  for (const name of ["cmake", "ninja"]) write(join(bin, name), "#!/bin/sh\necho canonical\n", 0o755);
  write(join(root, "sysroot/bun-wasm-sysroot.json"), JSON.stringify({ tools: [0, 1, 2, 3].map(index => ({ path: `/x${index}` })).concat([{ path: join(bin, "cmake") }, { path: join(bin, "ninja") }]) }));
  return bin;
}

test("the selected env.sh is a fixed point apart from repeated PATH prefixes and shell bookkeeping", () => {
  const root = fresh("fixed-point");
  const env = sourcedEnv(base(root, canonicalTools(root)), "source ./env.sh");
  const again = sourcedEnv(env, "source ./env.sh\nsource ./env.sh");
  expect(environmentDifferences(env, again)).toEqual([]);
  const drifting = sourcedEnv(env, "source ./env.sh\nexport CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS=\"$CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS -C extra\"");
  expect(environmentDifferences(env, drifting)).toEqual(["CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS"]);
  expect(environmentDifferences(env, { ...env, CFLAGS: "-O0" })).toEqual(["CFLAGS"]);
});

test("unit 4: a staged CMake or Ninja shadows the receipt's canonical tool and is refused", () => {
  const root = fresh("shadow");
  const canonical = canonicalTools(root);
  const env = sourcedEnv(base(root, canonical), "source ./env.sh");
  expect(() => requireCanonicalBuildTools(env, join(root, "sysroot"))).not.toThrow();
  write(join(root, "tools/cmake/bin/cmake"), "#!/bin/sh\necho private\n", 0o755);
  expect(() => requireCanonicalBuildTools(sourcedEnv(base(root, canonical), "source ./env.sh"), join(root, "sysroot"))).toThrow("canonical tool");
});

test("captures and builds read the same target flags only when both start from E", () => {
  const root = fresh("flags");
  const unsourced = base(root, canonicalTools(root));
  const env = sourcedEnv(unsourced, "source ./env.sh");
  // A build script sources env.sh itself, as build-bun-core.sh does.
  const build = sourcedEnv(env, "source ./env.sh").CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS;
  expect(env.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS).toBe(build);
  expect(build).toContain(`-L native=${join(root, "sysroot")}/lib/wasm32-wasip1`);
  // The assessed unit 5 fault: an unsourced capture recorded no flags, the sourced build did.
  expect(unsourced.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS).toBeUndefined();
});

const shortRoots: string[] = [];
afterAll(() => { for (const path of shortRoots) rmSync(path, { recursive: true, force: true }); });
const ROOT_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const ROOT_NAMES = Array.from(ROOT_CHARACTERS).flatMap(first => Array.from(ROOT_CHARACTERS, second => `${first}${second}`));
/**
 * A physical browser root short enough for the matrix suffix, as production
 * configures one: an exclusively created two-character directory under the
 * system temporary directory (12 bytes under /work/tmp).
 */
function shortRoot(): string {
  const parent = realpathSync(tmpdir());
  const name = ROOT_NAMES.find(candidate => {
    try { mkdirSync(join(parent, candidate)); return true; } catch { return false; }
  });
  if (!name) throw new Error(`no free short browser root under ${parent}`);
  const path = join(parent, name);
  shortRoots.push(path);
  if (Buffer.byteLength(`${path}/bun-wasm-engine-interruption-XXXXXX`) > 48) throw new Error(`${parent} is too long for a Chromium browser root`);
  return path;
}
function context(root: string, overrides: Partial<StageContext> = {}): StageContext {
  const report = join(root, "report"), browserTmp = shortRoot(), artifact = join(root, "artifact"), privateRoot = join(root, "private");
  for (const path of [report, artifact, privateRoot]) mkdirSync(path, { recursive: true });
  return { mode: "run", source: FIXTURE_SOURCE, sourceRoot: repository, manifest: { tuple: FIXTURE_TUPLE, native: { jsc: { root: join(root, "jsc") } } } as StageContext["manifest"],
    artifact, report, browserTmp, env: { PATH: "/usr/bin:/bin", MARK: "E", BUN_EXE: process.execPath }, owner: new ProcessOwner(),
    records: { config: Buffer.from("c"), inputs: Buffer.from("i"), environment: Buffer.from("e") }, privateRoot,
    facts: { source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, configSha256: sha256("c"), inputsSha256: sha256("i") }, produced: { source: FIXTURE_SOURCE, runtime: FIXTURE_TUPLE.runtime }, drafts: [], ...overrides };
}
const byName = (name: string): Stage => {
  const stage = STAGES.find(candidate => candidate.name === name);
  if (!stage) throw new Error(`no stage ${name}`);
  return stage;
};
function commandOf(name: string, value: StageContext) {
  const action = byName(name).action;
  if (action.kind !== "command") throw new Error(`${name} is not a command`);
  return action.command(value);
}

test("only the embedding stage binds a launcher, and it is the split producer's own", () => {
  const value = context(fresh("launcher"));
  expect(commandOf("jsc-embedding.log", value).overlay?.BUN_WASM_LAUNCHER).toBe(join(value.artifact, "split/launcher/bun-wasm"));
  const others = STAGES.filter(stage => stage.name !== "jsc-embedding.log" && stage.action.kind === "command").map(stage => commandOf(stage.name, value).overlay?.BUN_WASM_LAUNCHER);
  expect(others.filter(Boolean)).toEqual([]);
  expect(value.env.BUN_WASM_LAUNCHER).toBeUndefined();
});

test("every command runs in E plus only its declared overlay, so source-cache keeps E's sysroot flags", async () => {
  const value = context(fresh("overlay"), { env: { PATH: "/usr/bin:/bin", CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: "-L native=/sysroot/lib/wasm32-wasip1", MARK: "E" } });
  const dump = join(value.report, "env.txt");
  const probe: Stage = { name: "probe.log", eligibility: "generic-rehearsal", needs: [], browser: true, action: { kind: "command", command: () => ({ argv: ["/usr/bin/bash", "-c", `env > ${dump}`], overlay: { STAGE: "local" } }) } };
  await runStages(value, [probe], new AbortController().signal);
  const seen = readFileSync(dump, "utf8");
  for (const line of ["MARK=E", "STAGE=local", `TMPDIR=${value.browserTmp}`, "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS=-L native=/sysroot/lib/wasm32-wasip1"]) expect(seen).toContain(line);
  expect(commandOf("source-cache-browser-producer.log", value).overlay).toBeUndefined();
  expect(JSON.parse(readFileSync(join(value.report, "stages.json"), "utf8"))["probe.log"]).toMatchObject({ status: "ran", exit: 0, overlay: { STAGE: "local" } });
});

test("malformed stage tables are rejected before anything runs", () => {
  const step = { kind: "step", module: "/abs/steps.ts", name: "seal" } as const;
  expect(() => validateStages(STAGES)).not.toThrow();
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [], action: { ...step, command: () => ({ argv: [] }) } } as unknown as Stage])).toThrow("exactly one");
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [], action: { kind: "command" } } as unknown as Stage])).toThrow("exactly one");
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [], action: { kind: "step", step: () => {} } } as unknown as Stage])).toThrow("exactly one");
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [], action: { ...step, module: "relative.ts" } }])).toThrow("exactly one");
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [{ path: "x", from: "b" }], action: step }, { name: "b", eligibility: "generic-rehearsal", needs: [], action: step }])).toThrow("does not run before");
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [], action: step }, { name: "a", eligibility: "generic-rehearsal", needs: [], action: step }])).toThrow("repeated");
});

test("draft native inputs stop production at the first native stage", async () => {
  const value = context(fresh("draft"), { drafts: ["native.jsc: current stamp not admitted"] });
  expect(blockReason(value, byName("native-before.log"), {})).toContain("still draft");
  await expect(runStages(value, [byName("native-before.log")], new AbortController().signal)).rejects.toThrow("still draft");
});

test("rehearsal never builds, blocks current-source consumers on old bytes, and still runs generic mechanics", () => {
  const value = context(fresh("rehearse-old"), { mode: "rehearse", produced: { source: { head: "f".repeat(40), tree: "e".repeat(40) }, runtime: "0.0.109" } });
  expect(blockReason(value, byName("split-producer.log"), {})).toBe("production-only stage never runs in rehearsal");
  expect(blockReason(value, byName("jsc-embedding.log"), {})).toContain("current-source bytes are missing: split/manifest.json");
  for (const need of byName("web-guest-inputs.log").needs) write(join(value.artifact, need.path), "old bytes");
  expect(blockReason(value, byName("web-guest-inputs.log"), {})).toBeUndefined();
  expect(blockReason(value, byName("web-guests.log"), { "web-guest-inputs.log": { status: "ran", exit: 0 } })).toContain("retained bytes come from ffff");
  expect(blockReason(value, byName("seal.log"), {})).toBeUndefined();
});

test("a matching source with a stale receipt or a blocked prerequisite stays blocked", () => {
  const value = context(fresh("rehearse-stale"), { mode: "rehearse" });
  for (const need of byName("jsc-embedding.log").needs) write(join(value.artifact, need.path), "bytes without a valid receipt");
  write(join(value.artifact, "split/dist/bun.wasm.build.json"), "{}");
  expect(blockReason(value, byName("jsc-embedding.log"), {})).toContain("does not validate");
  const prerequisite: Stage = { name: "consumer.log", eligibility: "validated-retained", needs: [{ path: "split/dist/bun.wasm", from: "web-guest-inputs.log" }], action: { kind: "command", command: () => ({ argv: [] }) } };
  expect(blockReason(value, prerequisite, { "web-guest-inputs.log": { status: "blocked", reason: "x" } })).toBe("prerequisite web-guest-inputs.log blocked");
});

test("a generic copy, or plain file presence, never validates bytes for a consumer stage", () => {
  const value = context(fresh("rehearse-launder"), { mode: "rehearse" });
  for (const need of byName("web-guest-inputs.log").needs) write(join(value.artifact, need.path), "stale invalid bytes");
  expect(blockReason(value, byName("web-guest-inputs.log"), {})).toBeUndefined();
  // After the generic restage ran, and when the consumer suffix is selected directly.
  expect(blockReason(value, byName("web-guests.log"), { "web-guest-inputs.log": { status: "ran", exit: 0 } })).toContain("does not validate");
  expect(blockReason(value, byName("web-guests.log"), {})).toContain("does not validate");
  for (const name of ["source-cache-web-guests.log", "publication-inputs.log", "publication-matrix.log", "split-verify.log"]) {
    for (const need of byName(name).needs) write(join(value.artifact, need.path), "stale invalid bytes");
    expect(blockReason(value, byName(name), {})).toContain("does not validate");
  }
  const unvalidated: Stage = { name: "consumer.log", eligibility: "validated-retained", needs: [{ path: "split/dist/bun.wasm", from: "web-guest-inputs.log" }], action: { kind: "command", command: () => ({ argv: [] }) } };
  expect(blockReason(value, unvalidated, { "web-guest-inputs.log": { status: "ran", exit: 0 } })).toContain("no validator");
});

test("an explicitly requested production-only rehearsal stage refuses before any write", async () => {
  const run = { config: { roots: { rehearse: { report: join(scratch, "r"), private: join(scratch, "p"), browserTmp: "/work/tmp/c9" } } } } as Parameters<typeof rehearse>[0];
  await expect(rehearse(run, join(scratch, "retained"), "split-producer.log", new AbortController().signal)).rejects.toThrow("production-only");
  expect(existsSync(join(scratch, "r"))).toBe(false);
});

test("repeated staging replaces task-owned copies of 0444 originals without touching them", () => {
  const root = fresh("restage");
  const artifact = join(root, "artifact"), source = join(root, "source");
  const paths = handoffMemberPaths();
  const originals = ["split/dist/bun.wasm", "split/dist/quickjs.wasm", "split/dist/bun-jsc.wasm", "split/dist/jsc-engine.wasm", "split/dist/bun.wasm.build.json", "split/dist/bun-jsc.wasm.build.json"]
    .concat([paths.browserGuest, paths.sourceCacheBrowserGuest, paths.toolsGuest].flatMap(path => [`publication/${path}`, `publication/${path}.build.json`]));
  for (const path of originals) write(join(artifact, path), `original ${path}`, 0o444);
  const before = originals.map(path => statSync(join(artifact, path), { bigint: true })).map(stat => [stat.ino, stat.mode, stat.size]);
  for (const variant of ["default", "source-cache", "matrix"] as const) smokeInputs({ sourceRoot: source, artifact }, variant);
  expect(readFileSync(join(source, "dist/bun-browser.wasm"), "utf8")).toBe(`original publication/${paths.browserGuest}`);
  expect(lstatSync(join(source, "dist/bun.wasm")).mode & 0o777).toBe(0o644);
  expect(originals.map(path => statSync(join(artifact, path), { bigint: true })).map(stat => [stat.ino, stat.mode, stat.size])).toEqual(before);
  restage(join(artifact, "split/dist/bun.wasm"), join(source, "dist/bun.wasm"));
});

test("the observed matrix scratch must be a physical direct child within 48 bytes", () => {
  const root = fresh("m");
  const short = shortRoot();
  const scratchDir = join(short, "bun-wasm-engine-interruption-AbC123");
  mkdirSync(scratchDir);
  expect(verifyMatrixScratch(short, scratchDir).bytes).toBe(Buffer.byteLength(scratchDir));
  mkdirSync(join(root, "bun-wasm-engine-interruption-AbC123"));
  expect(() => verifyMatrixScratch(root, join(root, "bun-wasm-engine-interruption-AbC123"))).toThrow("bytes");
  expect(() => verifyMatrixScratch(short, join(short, "other"))).toThrow("unexpected matrix TMPDIR");
  expect(() => verifyMatrixScratch(short, join(root, "bun-wasm-engine-interruption-AbC123"))).toThrow("outside the browser scratch root");
});

test("a matrix runner that reports a foreign scratch and ignores TERM is stopped and refused", async () => {
  const value = context(fresh("matrix-stop"));
  const runner = join(value.privateRoot, "runner.ts");
  write(runner, `process.on("SIGTERM", () => {}); console.log(JSON.stringify({ resources: { scratch: "/tmp/elsewhere/bun-wasm-engine-interruption-XXXXXX" } })); setInterval(() => {}, 1000);`);
  const started = performance.now();
  await expect(publicationMatrix(value, new AbortController().signal, runner, { graceMs: 200, forceMs: 3000 })).rejects.toThrow("outside the browser scratch root");
  expect(performance.now() - started).toBeLessThan(10000);
});

test("the matrix refuses leftover browser scratch after its runner exits", async () => {
  const value = context(fresh("matrix-left"));
  const runner = join(value.privateRoot, "runner.ts");
  write(runner, `const { mkdtempSync } = require("node:fs"); const dir = mkdtempSync(process.env.TMPDIR + "/bun-wasm-engine-interruption-"); console.log(JSON.stringify({ resources: { scratch: dir } }));`);
  await expect(publicationMatrix(value, new AbortController().signal, runner)).rejects.toThrow("left browser scratch");
});

function webkitFixture(root: string) {
  const source = join(root, "source"), webkit = join(root, "jsc/webkit");
  mkdirSync(join(source, "jsc"), { recursive: true });
  mkdirSync(webkit, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", webkit, "-c", "user.name=f", "-c", "user.email=f@example.invalid"].concat(args), { encoding: "utf8" }).trim();
  git("init", "-q");
  write(join(webkit, "a.txt"), "one\n");
  git("add", "."); git("commit", "-qm", "base");
  const pin = git("rev-parse", "HEAD");
  write(join(webkit, "a.txt"), "two\n");
  write(join(source, "jsc/webkit-wasi.patch"), `${git("diff")}\n`);
  write(join(source, "jsc/common.sh"), `WEBKIT_COMMIT=${pin}\n`);
  return { source, jsc: join(root, "jsc"), webkit, git };
}
function gitWitness(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true }).map(entry => {
    const full = join(entry.parentPath, entry.name);
    const stat = lstatSync(full, { bigint: true });
    return `${full}\0${stat.mtimeNs}\0${stat.size}`;
  }).sort();
}

function reportWebkitFailure(fixture: ReturnType<typeof webkitFixture>, privateRoot: string, error: unknown): void {
  const roots = [fixture.webkit, fixture.source, privateRoot];
  const files = roots.flatMap(root => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && !join(entry.parentPath, entry.name).includes("/.git/hooks/"))
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      const stat = lstatSync(path, { bigint: true });
      return { path, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), ino: String(stat.ino), dev: String(stat.dev),
        mode: String(stat.mode), size: String(stat.size), bytes: readFileSync(path).toString("base64") };
    }));
  const record = JSON.stringify({ pid: process.pid, bun: Bun.version, error, files }, (_key, value: unknown) =>
    value instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, Reflect.get(value, key)])) : value);
  const directory = process.env.C1_WEBKIT_FAILURE_DIRECTORY;
  if (!directory) { console.error(record); return; }
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${process.pid}.json`);
  if (!existsSync(path)) writeFileSync(path, record, { flag: "wx" });
  console.error(`First WebKit admission failure saved to ${path}`);
}
function admitFixtureWebkit(fixture: ReturnType<typeof webkitFixture>, privateRoot: string): void {
  try { admitWebkit(fixture.source, fixture.jsc, privateRoot); }
  catch (error) { reportWebkitFailure(fixture, privateRoot, error); throw error; }
}

test("WebKit admission uses a private index and object store and never writes the original repository", () => {
  const fixture = webkitFixture(fresh("webkit-ok"));
  const before = gitWitness(join(fixture.webkit, ".git"));
  admitFixtureWebkit(fixture, fresh("webkit-ok-scratch"));
  expect(gitWitness(join(fixture.webkit, ".git"))).toEqual(before);
});

function statMatchedWebkitFixture(root: string) {
  const fixture = webkitFixture(root);
  fixture.git("config", "core.checkStat", "minimal");
  fixture.git("config", "core.trustctime", "false");
  fixture.git("checkout", "-q", "--", "a.txt");
  const file = join(fixture.webkit, "a.txt");
  utimesSync(file, 946684800, 946684800);
  fixture.git("add", "a.txt");
  utimesSync(join(fixture.webkit, ".git/index"), 946684800, 946684800);
  write(file, "two\n");
  utimesSync(file, 946684800, 946684800);
  return fixture;
}
test("WebKit admission compares patched bytes when the original index stat cache matches a same-size edit", () => {
  const fixture = statMatchedWebkitFixture(fresh("webkit-stat-matched"));
  const before = gitWitness(fixture.webkit);
  admitFixtureWebkit(fixture, fresh("webkit-stat-matched-scratch"));
  expect(readFileSync(join(fixture.webkit, "a.txt"), "utf8")).toBe("two\n");
  expect(gitWitness(fixture.webkit)).toEqual(before);
});

function sparseWebkitFixture(root: string) {
  const fixture = webkitFixture(root);
  fixture.git("checkout", "-q", "--", "a.txt");
  write(join(fixture.webkit, "unused.txt"), "unneeded upstream source\n");
  fixture.git("add", "unused.txt");
  fixture.git("commit", "-qm", "unneeded source");
  write(join(fixture.source, "jsc/common.sh"), `WEBKIT_COMMIT=${fixture.git("rev-parse", "HEAD")}\n`);
  fixture.git("sparse-checkout", "set", "--no-cone", "/a.txt");
  fixture.git("apply", join(fixture.source, "jsc/webkit-wasi.patch"));
  const blob = fixture.git("rev-parse", "HEAD:unused.txt");
  const object = join(fixture.webkit, ".git/objects", blob.slice(0, 2), blob.slice(2));
  chmodSync(object, 0o644);
  rmSync(object);
  return fixture;
}

test("sparse WebKit admission accepts an absent unused blob without fetching or original writes", () => {
  const fixture = sparseWebkitFixture(fresh("webkit-sparse"));
  const before = gitWitness(join(fixture.webkit, ".git"));
  admitFixtureWebkit(fixture, fresh("webkit-sparse-scratch"));
  expect(readFileSync(join(fixture.webkit, "a.txt"), "utf8")).toBe("two\n");
  expect(gitWitness(join(fixture.webkit, ".git"))).toEqual(before);
});

test("sparse WebKit admission still refuses changed required source without fetching or original writes", () => {
  const fixture = sparseWebkitFixture(fresh("webkit-sparse-changed"));
  write(join(fixture.webkit, "a.txt"), "changed required source\n");
  const before = gitWitness(join(fixture.webkit, ".git"));
  let failure: unknown;
  try { admitWebkit(fixture.source, fixture.jsc, fresh("webkit-sparse-changed-scratch")); }
  catch (error) { failure = error; }
  if (!(failure instanceof AdmissionError)) throw new Error("Expected working-tree admission failure", { cause: failure });
  expect(failure.message).toContain("working tree differs");
  expect(failure.cause).toBeInstanceOf(Error);
  expect(failure.cause).toMatchObject({ status: 1 });
  expect(failure.cause).toHaveProperty("stdout");
  expect(failure.cause).toHaveProperty("stderr");
  if (failure.cause instanceof Error) expect(failure.cause.message).toContain("diff --quiet");
  expect(gitWitness(join(fixture.webkit, ".git"))).toEqual(before);
});

test("WebKit admission with a missing object refuses without fetching or adding objects", () => {
  const fixture = webkitFixture(fresh("webkit-missing"));
  const blob = fixture.git("rev-parse", "HEAD:a.txt");
  const object = join(fixture.webkit, ".git/objects", blob.slice(0, 2), blob.slice(2));
  chmodSync(object, 0o644);
  rmSync(object);
  const before = gitWitness(join(fixture.webkit, ".git"));
  expect(() => admitWebkit(fixture.source, fixture.jsc, fresh("webkit-missing-scratch"))).toThrow();
  expect(gitWitness(join(fixture.webkit, ".git"))).toEqual(before);
});

test("sysroot admission with missing staged Waffle inputs refuses instead of downloading", () => {
  const tools = fresh("waffle-missing");
  const result = spawnSync(process.execPath, ["-e", SYSROOT_PROBE], { cwd: repository, encoding: "utf8", env: { PATH: "/usr/bin:/bin", WASM_TOOLS: tools, WASI_SDK_PATH: join(tools, "sdk"), BUN_WASM_SYSROOT: join(tools, "sysroot") } });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("staged Waffle native inputs are missing");
  expect(readdirSync(tools)).toEqual([]);
});

test("the controller refuses missing staged Waffle inputs before the sysroot builder's downloader is reachable", () => {
  const tools = fresh("waffle-staged-missing");
  expect(() => requireStagedWaffle({ WASM_TOOLS: tools }, repository)).toThrow("staged Waffle native input is missing");
  expect(readdirSync(tools)).toEqual([]);
});

/** Exactly the maintained helper, sourced from this checkout, against an owned tiny WebKit and native root. */
function maintainedWebkitCheck(fixture: ReturnType<typeof webkitFixture>, native: string) {
  const tools = fresh("maintained-webkit-tools");
  const bin = join(tools, "bin");
  mkdirSync(bin, { recursive: true });
  // Sourcing common.sh resolves wasm-opt, but this read-only check must never execute it.
  write(join(bin, "wasm-opt"), "#!/bin/sh\nexit 99\n", 0o755);
  const script = 'set -x\nsource "$1/jsc/common.sh"\nWEBKIT_DIR="$2"\nJSC_SRC="$3"\nWEBKIT_COMMIT="$4"\ncheck_jsc_webkit_tree\n';
  const pin = fixture.git("rev-parse", "HEAD~0");
  return spawnSync("/usr/bin/bash", ["-c", script, "webkit-check", repository, fixture.webkit, join(fixture.source, "jsc"), pin],
    { encoding: "utf8", env: { ...process.env, WASM_TOOLS: tools, PATH: `${bin}:/usr/bin:/bin`, JSC_BUILD_DIR: native, TMPDIR: fresh(`webkit-tmp-${Math.random().toString(36).slice(2)}`) } });
}
test("the maintained WebKit check writes neither the native root nor the repository, at every caller", () => {
  const root = fresh("maintained-webkit");
  const fixture = webkitFixture(root);
  fixture.git("checkout", "-q", "--", "a.txt");
  fixture.git("apply", join(fixture.source, "jsc/webkit-wasi.patch"));
  const native = fixture.jsc;
  const before = gitWitness(native);
  const rootBefore = lstatSync(native, { bigint: true }).mtimeNs;
  const result = maintainedWebkitCheck(fixture, native);
  if (result.status !== 0) reportWebkitFailure(fixture, fixture.source, result);
  expect({ status: result.status, signal: result.signal, stderr: result.stderr, stdout: result.stdout, error: result.error }).toMatchObject({ status: 0 });
  expect(gitWitness(native)).toEqual(before);
  expect(lstatSync(native, { bigint: true }).mtimeNs).toBe(rootBefore);
});
test("the maintained WebKit check compares patched bytes when the original index stat cache matches", () => {
  const fixture = statMatchedWebkitFixture(fresh("maintained-webkit-stat-matched"));
  const before = gitWitness(fixture.jsc);
  const result = maintainedWebkitCheck(fixture, fixture.jsc);
  if (result.status !== 0) reportWebkitFailure(fixture, fixture.source, result);
  expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toMatchObject({ status: 0 });
  expect(gitWitness(fixture.jsc)).toEqual(before);
});
test("the maintained WebKit check refuses a missing object without fetching or adding any", () => {
  const root = fresh("maintained-webkit-missing");
  const fixture = webkitFixture(root);
  const blob = fixture.git("rev-parse", "HEAD:a.txt");
  const object = join(fixture.webkit, ".git/objects", blob.slice(0, 2), blob.slice(2));
  chmodSync(object, 0o644);
  rmSync(object);
  const before = gitWitness(fixture.jsc);
  expect(maintainedWebkitCheck(fixture, fixture.jsc).status).not.toBe(0);
  expect(gitWitness(fixture.jsc)).toEqual(before);
});

/** A tiny synthetic SDK, sysroot and tool PATH, enough for the maintained jsc_inputs_hash to run. */
function stampFixture(root: string, stamp: string) {
  const bin = join(root, "bin");
  for (const name of ["cmake", "ninja", "wasm-opt"]) write(join(bin, name), `#!/bin/sh\necho "${name} version 1"\n`, 0o755);
  for (const name of ["clang", "clang++"]) write(join(root, "sdk/bin", name), `#!/bin/sh\necho "${name} version 1"\n`, 0o755);
  write(join(root, "sdk/VERSION"), "1\n");
  write(join(root, "sysroot/bun-wasm-sysroot.json"), "{}");
  write(join(root, "jsc/build/jsc/.bunwasm-inputs"), stamp);
  for (const file of ["wasi-jsc.cmake", "shim/wasi-compat.h", "shim/wasi-compat.c", "shim/madvise.c"]) write(join(root, "jsc/inputs", file), `${file}\n`);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, WASM_TOOLS: join(root, "tools"), WASI_SDK_PATH: join(root, "sdk"), BUN_WASM_SYSROOT: join(root, "sysroot"),
    JSC_BUILD_DIR: join(root, "jsc"), CARGO_HOME: join(root, "cargo"), RUSTUP_HOME: join(root, "rustup"), CARGO_TARGET_DIR: join(root, "t"), TMPDIR: join(root, "tmp"), BUN_EXE: process.execPath };
  mkdirSync(env.TMPDIR, { recursive: true });
  return env;
}
test("a wrong JSC stamp refuses in preclaim native admission, before Waffle inputs or any claim, and is never restamped", async () => {
  const root = fresh("wrong-stamp");
  const env = stampFixture(root, "not-the-current-inputs\n");
  const before = nativeWitness([join(root, "jsc"), join(root, "sysroot")]);
  const staging = new Staging(repository, fresh("wrong-stamp-private"));
  const error = await requireNativeEntry(repository, { jsc: join(root, "jsc"), sysroot: join(root, "sysroot") }, env, staging, new ProcessOwner(), new AbortController().signal).catch((reason: unknown) => reason);
  expect(String(error)).toContain("different JSC inputs");
  expect(String(error)).not.toContain("Waffle");
  expect(readFileSync(join(root, "jsc/build/jsc/.bunwasm-inputs"), "utf8")).toBe("not-the-current-inputs\n");
  expect(nativeWitness([join(root, "jsc"), join(root, "sysroot")])).toBe(before);
});

test("every step runs as an owned child: abort drains a step stuck in a maintained synchronous helper", async () => {
  const value = context(fresh("step-abort"));
  const pidFile = join(value.privateRoot, "sleep.pid");
  const module = join(value.privateRoot, "hang-steps.ts");
  write(module, `import { run } from ${JSON.stringify(join(repository, "scripts/guest-source-manifest.ts"))};
export const steps = { hang: () => { run(["/usr/bin/bash", "-c", "echo $$ > ${pidFile}; exec /usr/bin/sleep 30"], "/"); } };\n`);
  const stage: Stage = { name: "hang.log", eligibility: "generic-rehearsal", needs: [], action: { kind: "step", module, name: "hang" } };
  const abort = new AbortController();
  const running = runStages(value, [stage], abort.signal, { graceMs: 200, forceMs: 3000 });
  for (let tries = 0; tries < 200 && !existsSync(pidFile); tries++) await Bun.sleep(25);
  const started = performance.now();
  abort.abort(new Error("controller cancelled"));
  await expect(running).rejects.toThrow("controller cancelled");
  expect(performance.now() - started).toBeLessThan(10000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  expect(alive).toBe(false);
});

test("a step receives its context, including records, and runs in E", async () => {
  const value = context(fresh("step-context"));
  const module = join(value.privateRoot, "echo-steps.ts");
  const out = join(value.privateRoot, "seen.json");
  write(module, `import { writeFileSync } from "node:fs";
export const steps = { echo: (context: { mode: string; records: { config: Uint8Array } }) => writeFileSync(${JSON.stringify(out)}, JSON.stringify({ mode: context.mode, config: new TextDecoder().decode(context.records.config), mark: process.env.MARK })) };\n`);
  await runStages(value, [{ name: "echo.log", eligibility: "generic-rehearsal", needs: [], action: { kind: "step", module, name: "echo" } }], new AbortController().signal);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ mode: "run", config: "c", mark: "E" });
});

test("teardown removes sealed owned copies after drain, and records a removal it cannot make instead of losing the receipt", async () => {
  const root = fresh("teardown");
  const plan = { operation: "rehearse" as const, admission: [{ name: "private", path: join(root, "private"), retained: false }], durable: [] };
  const invocation = new Invocation(plan, repository);
  invocation.claimed.claim(plan.admission);
  const sealed = join(root, "private/retained-copy/delivery/split");
  write(join(sealed, "member"), "sealed copy", 0o444);
  chmodSync(sealed, 0o555);
  chmodSync(dirname(sealed), 0o555);
  const cleanup = await invocation.teardown({ graceMs: 100, forceMs: 1000 });
  expect(cleanup).toMatchObject({ drained: true, removalFailed: [] });
  expect(existsSync(join(root, "private"))).toBe(false);
  const locked = fresh("teardown-locked");
  const stuck = { operation: "rehearse" as const, admission: [{ name: "private", path: join(locked, "private"), retained: false }], durable: [] };
  const other = new Invocation(stuck, repository);
  other.claimed.claim(stuck.admission);
  chmodSync(locked, 0o555);
  const failed = await other.teardown({ graceMs: 100, forceMs: 1000 });
  chmodSync(locked, 0o755);
  expect(failed.drained).toBe(true);
  expect(failed.removalFailed.map(entry => entry.path)).toEqual([join(locked, "private")]);
});

test("controller success refuses unsafe, failed or source-dirty cleanup", () => {
  const clean: Cleanup = { drained: true, survivors: [], removed: [], retainedUnsafe: [], removalFailed: [], retained: ["report"], sourceClean: true };
  expect(operationSucceeded({ cleanup: clean })).toBe(true);
  expect(operationSucceeded({ error: new Error("failed"), cleanup: clean })).toBe(false);
  const failures: readonly Partial<Cleanup>[] = [
    { drained: false }, { survivors: ["owned process"] }, { retainedUnsafe: ["scratch"] },
    { removalFailed: [{ path: "scratch", error: "EACCES" }] }, { sourceClean: false },
  ];
  for (const failure of failures) expect(operationSucceeded({ cleanup: { ...clean, ...failure } })).toBe(false);
});

test("the rehearsal witness covers content, not just metadata", () => {
  const root = fresh("witness");
  write(join(root, "a/file"), "one");
  const before = treeWitness(root).join("\n");
  const stat = statSync(join(root, "a/file"));
  writeFileSync(join(root, "a/file"), "two");
  utimesSync(join(root, "a/file"), stat.atime, stat.mtime);
  expect(treeWitness(root).join("\n")).not.toBe(before);
});
