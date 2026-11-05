import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enableSubreaper } from "../linux-subreaper.mts";
import { ProcessOwner } from "../process-owner.mts";
import { handoffMemberPaths } from "../producer-closure.ts";
import { SYSROOT_PROBE, environmentDifferences, requireCanonicalBuildTools } from "./admission.ts";
import { FIXTURE_SOURCE, FIXTURE_TUPLE } from "./contract-fixture.ts";
import { sha256 } from "./identity.ts";
import { admitWebkit } from "./inputs.ts";
import { rehearse } from "./operations.ts";
import { publicationMatrix, restage, smokeInputs, verifyMatrixScratch } from "./publication.ts";
import { STAGES, blockReason, runStages, validateStages, type Stage, type StageContext } from "./stages.ts";

const repository = realpathSync(join(import.meta.dir, "../.."));
let scratch = "";
beforeAll(async () => {
  await enableSubreaper();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "bun-wasm-c1-controller-")));
});
afterAll(() => {
  execFileSync("/usr/bin/chmod", ["-R", "u+w", scratch]);
  rmSync(scratch, { recursive: true, force: true });
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
/** A physical browser root short enough for the matrix suffix: `/tmp/c` plus six characters is 12 bytes. */
function shortRoot(): string {
  const path = mkdtempSync("/tmp/c");
  shortRoots.push(path);
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
  const step = { kind: "step", step: () => {} } as const;
  expect(() => validateStages(STAGES)).not.toThrow();
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [], action: { ...step, command: () => ({ argv: [] }) } } as unknown as Stage])).toThrow("exactly one");
  expect(() => validateStages([{ name: "a", eligibility: "generic-rehearsal", needs: [], action: { kind: "command" } } as unknown as Stage])).toThrow("exactly one");
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
  expect(blockReason(value, byName("web-guests.log"), { "web-guest-inputs.log": { status: "blocked", reason: "x" } })).toBe("prerequisite web-guest-inputs.log blocked");
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
  expect(verifyMatrixScratch(short, scratchDir).bytes).toBe(48);
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

test("WebKit admission uses a private index and object store and never writes the original repository", () => {
  const fixture = webkitFixture(fresh("webkit-ok"));
  const before = gitWitness(join(fixture.webkit, ".git"));
  admitWebkit(fixture.source, fixture.jsc, fresh("webkit-ok-scratch"));
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
