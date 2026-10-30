import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";

// The JSC C/C++ prebuild runs in its own job and hands one verified archive to the
// native job. These tests pin the job graph, the shared setup and the hand-off.

type Job = Readonly<Record<string, unknown>>;
type Need = { readonly result: string; readonly outputs?: Readonly<Record<string, string>> };

function record(value: unknown): Job {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobs = record(record(Bun.YAML.parse(source)).jobs);
const producer = record(jobs["jsc-prebuild"]);
const native = record(jobs.rust);

function steps(job: Job): Job[] {
  if (!Array.isArray(job.steps)) throw new Error("Expected job steps");
  return job.steps.map(record);
}

function step(job: Job, key: string, value: string): Job {
  const found = steps(job).filter(item => item[key] === value);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function run(job: Job, name: string): string {
  const script = step(job, "name", name).run;
  if (typeof script !== "string") throw new Error(`Missing script: ${name}`);
  return script;
}

const packageName = "Package the verified prebuild and sysroot";
const importName = "Import the verified JSC prebuild and sysroot";
const guardName = "Require the JSC prebuild job's output";

// GitHub job conditions: without a status function the condition is implicitly
// `success() && ...`, so a failed or skipped need skips the job.
function clause(text: string, needs: Readonly<Record<string, Need>>, cancelled: boolean): boolean {
  if (text === "!cancelled()") return !cancelled;
  const group = /^\((.*)\)$/.exec(text);
  if (group) return group[1]!.split(" || ").some(option => clause(option, needs, cancelled));
  const match = /^needs\.([\w-]+)\.(result|outputs\.([\w-]+)) == '([^']*)'$/.exec(text);
  if (!match) throw new Error(`Unsupported job condition: ${text}`);
  const need = needs[match[1]!];
  if (!need) throw new Error(`Condition reads an undeclared need: ${match[1]}`);
  const value = match[3] ? need.outputs?.[match[3]] ?? "" : need.result;
  return value === match[4];
}

function jobRuns(job: Job, needs: Readonly<Record<string, Need>>, cancelled: boolean): boolean {
  const declared = typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs : [];
  expect(Object.keys(needs).toSorted()).toEqual(declared.toSorted());
  const condition = typeof job.if === "string" ? job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "") : "";
  const explicit = /\b(?:success|failure|always|cancelled)\(\)/.test(condition);
  const implicit = explicit || (!cancelled && Object.values(needs).every(need => need.result === "success"));
  return implicit && (!condition || condition.split(" && ").every(part => clause(part, needs, cancelled)));
}

function guard(result: string): number | null {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", run(native, guardName)], {
    env: { ...process.env, JSC_PREBUILD_RESULT: result }, encoding: "utf8", timeout: 3000,
  }).status;
}

test("the prebuild job runs for every native selection, independent of the JSC engine gates", () => {
  expect(producer.needs).toBe("quality");
  expect(producer.if).toBe("needs.quality.outputs.rust == 'true'");
  expect(JSON.stringify(producer)).not.toContain("needs.quality.outputs.jsc");
  expect(native.needs).toEqual(["quality", "jsc-prebuild"]);
  // A native-only change still builds the tools fixture, which links the prebuild.
  for (const [path, jsc] of [["crates/bunwasm-runtime/src/engine_quickjs.rs", false], ["jsc/configure.sh", true], ["scripts/build-jsc.sh", true]] satisfies [string, boolean][]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(jsc);
  }
  expect(needsRust(["docs/code-quality.md"])).toBe(false);
});

type GraphCase = { quality: string; rust: string; jsc: string; outcome: string; cancelled: boolean };

const graphCases: GraphCase[] = ["success", "failure"].flatMap(quality => ["true", "false"].flatMap(rust => ["true", "false"].flatMap(jsc =>
  ["success", "failure", "cancelled"].flatMap(outcome => [false, true].map(cancelled => ({ quality, rust, jsc, outcome, cancelled }))))));

function checkGraph({ quality, rust, jsc, outcome, cancelled }: GraphCase) {
  const qualityNeed = { result: quality, outputs: { rust, jsc, hermes: "false", shared: "false" } };
  const prebuildRuns = jobRuns(producer, { quality: qualityNeed }, cancelled);
  const prebuild = { result: prebuildRuns ? outcome : "skipped" };
  const nativeRuns = jobRuns(native, { quality: qualityNeed, "jsc-prebuild": prebuild }, cancelled);
  const selected = quality === "success" && rust === "true" && !cancelled;
  expect(prebuildRuns).toBe(selected);
  // Skipping is reserved for the change filter, a failed quality job or a cancelled run.
  expect(nativeRuns).toBe(selected);
  if (!nativeRuns) return;
  expect(guard(prebuild.result)).toBe(outcome === "success" ? 0 : 1);
  if (outcome === "success") return;
  // Later consumers of native outputs do not run after a failed native job.
  const hermes = { ...qualityNeed, outputs: { ...qualityNeed.outputs, hermes: "true" } };
  expect(jobRuns(record(jobs.hermes), { quality: hermes, rust: { result: "failure" } }, cancelled)).toBe(false);
}

test("the native check fails, never skips, when its selected prebuild did not succeed", () => {
  expect(steps(native)[0]?.name).toBe(guardName);
  expect(graphCases).toHaveLength(48);
  for (const graphCase of graphCases) checkGraph(graphCase);
  for (const result of ["failure", "cancelled", "skipped", ""]) expect(guard(result)).toBe(1);
});

test("both jobs run byte-identical setup, so the native job can re-verify in the same environment", () => {
  const shared = (job: Job) => steps(job).filter(item => {
    const name = String(item.name ?? "");
    const uses = String(item.uses ?? "");
    const id = String(item.id ?? "");
    return ["Configure portable quality toolchain homes", "Install native build tools", "Identify host build tools", "Install pinned WASI SDK",
      "Save completed sdk setup", "Install pinned Binaryen", "Save completed binaryen-cache setup", "Identify JSC prebuild inputs"].includes(name)
      || ["sdk", "binaryen-cache"].includes(id) || uses.startsWith("oven-sh/setup-bun") || uses === "actions/checkout@v4"
      || item.run === "bun install --frozen-lockfile --ignore-scripts"
      || (uses === "actions/cache/restore@v4" && JSON.stringify(item.with).includes("~/.bun/install/cache"));
  });
  const producerShared = shared(producer);
  expect(producerShared).toHaveLength(14);
  expect(producerShared).toEqual(shared(native));
  const nativePaths = run(native, "Configure private JSC build paths");
  expect(run(producer, "Configure private JSC build paths")).toBe(nativePaths.slice(0, nativePaths.indexOf("\n")));
  expect(run(native, "Configure private JSC build paths")).toContain('JSC_BUILD_DIR=$RUNNER_TEMP/jsc/prebuild" >> "$GITHUB_ENV"\n');
  // The producer compiles no Rust and needs no upstream Bun sources.
  expect(JSON.stringify(producer)).not.toContain("rust-toolchain");
  expect(JSON.stringify(producer)).not.toContain("sync-bun.sh");
});

test("one job owns the sysroot and prebuild builds and caches; the native job only imports and verifies", () => {
  const ownedIds = ["sysroot-inputs", "sysroot-cache", "jsc-prebuild-cache", "jsc-producer", "jsc-artifact"];
  for (const id of ownedIds) {
    expect(steps(producer).filter(item => item.id === id)).toHaveLength(1);
    expect(steps(native).filter(item => item.id === id)).toHaveLength(0);
  }
  for (const name of ["Save the verified sysroot cache", "Build or verify the JSC prebuild", "Save the JSC prebuild cache once per input revision"]) {
    expect(steps(native).filter(item => item.name === name)).toHaveLength(0);
  }
  expect(source.match(/bash scripts\/build-jsc\.sh/g)).toHaveLength(1);
  expect(step(producer, "name", "Save the JSC prebuild cache once per input revision").if)
    .toBe("${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.jsc-producer.outputs.jsc-ready == 'true' && steps.jsc-prebuild-cache.outputs.cache-hit != 'true' }}");
  expect(step(producer, "id", "jsc-producer").env).toEqual({ CI_JSC_PREBUILD_HIT: "${{ steps.jsc-prebuild-cache.outputs.cache-matched-key != '' }}" });
  const names = steps(native).map(item => String(item.name ?? item.uses ?? ""));
  const download = steps(native).findIndex(item => item.uses === "actions/download-artifact@v4" && record(item.with).name === "jsc-prebuild");
  expect(download).toBe(names.indexOf(importName) - 1);
  expect(names.indexOf("Configure private JSC build paths")).toBe(download - 1);
  for (const later of ["Build patched WASI sysroot", "Identify effective native build environment", "Identify JSC prebuild inputs", "Blocking native quality checks", "Build the single tools fixture in the existing native target"]) {
    expect(names.indexOf(later)).toBeGreaterThan(names.indexOf(importName));
  }
  expect(run(native, "Build patched WASI sysroot")).toContain("bun scripts/build-wasi-sysroot.ts");
  const upload = steps(producer).at(-1)!;
  expect(upload.uses).toBe("actions/upload-artifact@v4");
  expect(upload.with).toEqual({ name: "jsc-prebuild", path: "${{ runner.temp }}/jsc-prebuild-artifact/", "if-no-files-found": "error", "retention-days": 1, "compression-level": 0 });
  expect(steps(producer).at(-2)?.name).toBe(packageName);
  expect(producer.outputs).toEqual({ "manifest-sha256": "${{ steps.jsc-artifact.outputs.manifest-sha256 }}" });
  expect(step(native, "name", importName).env).toEqual({ JOBS: "2", CAGE: "", JSC_PREBUILD_MANIFEST_SHA256: "${{ needs.jsc-prebuild.outputs.manifest-sha256 }}" });
  // No background work or bare PIDs cross a step boundary in the hand-off.
  for (const script of [run(producer, packageName), run(native, importName), run(native, guardName)]) {
    expect(script).not.toMatch(/setsid|&\s*$|\$!|kill /m);
  }
});

type Harness = { root: string; repo: string; temp: string; env: Record<string, string> };

function harness(temp = "temp"): Harness {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-handoff-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "jsc"), { recursive: true });
  copyFileSync(new URL("../env.sh", import.meta.url), join(repo, "env.sh"));
  // The real stamp check needs the WebKit toolchain; the stub records each call and
  // rejects a missing or wrong stamp, so the hand-off's own checks stay real.
  writeFileSync(join(repo, "jsc/common.sh"), [
    "source env.sh",
    "check_jsc_inputs_stamp() {",
    '  printf "stamp\\n" >> "$STAMP_CALLS"',
    '  [[ "$(cat "$JSC_BUILD_DIR/build/jsc/.bunwasm-inputs" 2>/dev/null)" == "${EXPECTED_STAMP:-expected-inputs}" ]]',
    "}",
    "",
  ].join("\n"));
  return { root, repo, temp: join(root, temp), env: environment(root, temp) };
}

function environment(root: string, temp: string): Record<string, string> {
  const runnerTemp = join(root, temp);
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, RUNNER_TEMP: runnerTemp, TMPDIR: runnerTemp,
    WASM_TOOLS: join(runnerTemp, "wasm-tools"), JSC_BUILD_DIR: join(runnerTemp, "jsc/prebuild"),
    GITHUB_RUN_ID: "4100", GITHUB_SHA: "433aca4ea0d761c23fc1661aa8c636e75dfdd6b3",
    GITHUB_OUTPUT: join(root, "outputs"), STAMP_CALLS: join(root, "stamp-calls"),
  };
}

function seedProducerTrees(h: Harness) {
  const prebuild = h.env.JSC_BUILD_DIR!;
  const sysroot = join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched");
  const sdk = join(h.env.WASM_TOOLS!, "wasi-sdk/share/wasi-sysroot/include/c++");
  mkdirSync(join(prebuild, "build/jsc/lib"), { recursive: true });
  mkdirSync(join(prebuild, "webkit/.git"), { recursive: true });
  mkdirSync(join(sysroot, "lib/wasm32-wasip1"), { recursive: true });
  mkdirSync(join(sysroot, "include"), { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(prebuild, "build/jsc/.bunwasm-inputs"), "expected-inputs");
  writeFileSync(join(prebuild, "build/jsc/lib/libJavaScriptCore.a"), "archive\0bytes");
  writeFileSync(join(prebuild, "build/jsc/CMakeCache.txt"), `CMAKE_TOOLCHAIN_FILE:FILEPATH=${prebuild}/inputs/wasi-jsc.cmake\n`);
  writeFileSync(join(prebuild, "webkit/.git/HEAD"), "3d3257150c40a1aabdc5f8b48d5b33d0413674cb\n");
  writeFileSync(join(prebuild, "jsc.wasm"), "wasm", { mode: 0o755 });
  symlinkSync("lib/libJavaScriptCore.a", join(prebuild, "build/jsc/libJavaScriptCore.link"));
  writeFileSync(join(sysroot, "lib/wasm32-wasip1/libc.a"), "libc");
  writeFileSync(join(sysroot, "bun-wasm-sysroot.json"), '{"receipt":true}');
  // Absolute SDK overlays only resolve at the same absolute paths.
  symlinkSync(sdk, join(sysroot, "include/c++"), "dir");
  utimesSync(join(prebuild, "build/jsc/lib/libJavaScriptCore.a"), 1_700_000_000, 1_700_000_000);
  writeFileSync(join(h.temp, "jsc-prebuild.log"), "prebuild log\n");
  writeFileSync(h.env.GITHUB_OUTPUT!, "");
  writeFileSync(h.env.STAMP_CALLS!, "");
}

function snapshot(directory: string): string[] {
  const entries: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path).toSorted()) {
      const child = join(path, name);
      const stat = lstatSync(child);
      const kind = stat.isSymbolicLink() ? `link:${readlinkSync(child)}` : stat.isDirectory() ? "dir" : `file:${readFileSync(child, "base64")}:${Math.floor(stat.mtimeMs / 1000)}`;
      entries.push(`${relative(directory, child)} ${(stat.mode & 0o777).toString(8)} ${kind}`);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child);
    }
  };
  walk(directory);
  return entries;
}

function bash(h: Harness, script: string, env: Record<string, string> = {}) {
  // Actions runs `run:` scripts with `bash -e`; each hand-off script adds pipefail itself.
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], { cwd: h.repo, env: { ...h.env, ...env }, encoding: "utf8", timeout: 20000 });
}

function produce(h: Harness): { digest: string; prebuild: string[]; sysroot: string[] } {
  seedProducerTrees(h);
  const sysrootPath = join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched");
  const before = { prebuild: snapshot(h.env.JSC_BUILD_DIR!), sysroot: snapshot(sysrootPath) };
  const result = bash(h, run(producer, packageName));
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const digest = /^manifest-sha256=([0-9a-f]{64})\n$/.exec(readFileSync(h.env.GITHUB_OUTPUT!, "utf8"))?.[1];
  if (!digest) throw new Error("Package step did not report a manifest digest");
  // A fresh runner: only the downloaded artifact exists, at the download path.
  rmSync(h.env.JSC_BUILD_DIR!, { recursive: true });
  rmSync(sysrootPath, { recursive: true });
  return { digest, ...before };
}

function consume(h: Harness, digest: string, env: Record<string, string> = {}) {
  return bash(h, run(native, importName), { JSC_PREBUILD_MANIFEST_SHA256: digest, ...env });
}

function withHarness(body: (h: Harness) => void) {
  const h = harness();
  try { body(h); }
  finally { rmSync(h.root, { recursive: true, force: true }); }
}

const bundle = (h: Harness) => join(h.temp, "jsc-prebuild-artifact");

test("the imported prebuild and sysroot are the producer's exact trees at the same absolute paths", () => withHarness(h => {
  const produced = produce(h);
  expect(readdirSync(bundle(h)).toSorted()).toEqual(["jsc-prebuild.log", "manifest", "prebuild.tar.zst", "sysroot.tar.zst"]);
  expect(readFileSync(join(bundle(h), "manifest"), "utf8").split("\n").slice(0, 4)).toEqual([
    "run=4100", "sha=433aca4ea0d761c23fc1661aa8c636e75dfdd6b3", `jsc-build-dir=${h.env.JSC_BUILD_DIR}`, `sysroot=${h.env.WASM_TOOLS}/bun-wasm-sysroot-patched`,
  ]);
  const result = consume(h, produced.digest);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(snapshot(h.env.JSC_BUILD_DIR!)).toEqual(produced.prebuild);
  expect(snapshot(join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched"))).toEqual(produced.sysroot);
  expect(readFileSync(join(h.temp, "jsc-prebuild.log"), "utf8")).toBe("prebuild log\n");
  expect(existsSync(bundle(h))).toBe(false);
  expect(readFileSync(h.env.STAMP_CALLS!, "utf8")).toBe("stamp\n");
}));

function expectRejectedBeforeExtraction(h: Harness, result: ReturnType<typeof consume>) {
  expect(result.status).not.toBe(0);
  expect(existsSync(h.env.JSC_BUILD_DIR!)).toBe(false);
  expect(existsSync(join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched"))).toBe(false);
  expect(readFileSync(h.env.STAMP_CALLS!, "utf8")).toBe("");
}

for (const [label, digest] of [
  ["no reported digest (prebuild output missing)", ""],
  ["a malformed digest", "not-a-digest"],
  ["another manifest's digest", "0".repeat(64)],
] satisfies [string, string][]) {
  test(`import rejects ${label} before extracting anything`, () => withHarness(h => {
    produce(h);
    expectRejectedBeforeExtraction(h, consume(h, digest));
  }));
}

test("import rejects an artifact from another run or commit even with that artifact's own digest", () => withHarness(h => {
  const { digest } = produce(h);
  expectRejectedBeforeExtraction(h, consume(h, digest, { GITHUB_RUN_ID: "4101" }));
  expectRejectedBeforeExtraction(h, consume(h, digest, { GITHUB_SHA: "0".repeat(40) }));
}));

test("import rejects a relocated consumer before extracting anything", () => withHarness(h => {
  const { digest } = produce(h);
  const moved = environment(h.root, "elsewhere");
  mkdirSync(moved.RUNNER_TEMP!, { recursive: true });
  renameSync(bundle(h), join(moved.RUNNER_TEMP!, "jsc-prebuild-artifact"));
  const result = bash(h, run(native, importName), { ...moved, JSC_PREBUILD_MANIFEST_SHA256: digest });
  expect(result.status).not.toBe(0);
  expect(existsSync(moved.JSC_BUILD_DIR!)).toBe(false);
  expect(existsSync(join(moved.WASM_TOOLS!, "bun-wasm-sysroot-patched"))).toBe(false);
}));

for (const archive of ["prebuild.tar.zst", "sysroot.tar.zst"]) {
  test(`import rejects a corrupted or missing ${archive} before extracting anything`, () => withHarness(h => {
    const { digest } = produce(h);
    const path = join(bundle(h), archive);
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.map((byte, index) => index === bytes.length - 1 ? byte ^ 1 : byte));
    expectRejectedBeforeExtraction(h, consume(h, digest));
    rmSync(path);
    expectRejectedBeforeExtraction(h, consume(h, digest));
  }));
}

test("import rejects a manifest that lists other archives, even with its own digest", () => withHarness(h => {
  produce(h);
  const manifest = join(bundle(h), "manifest");
  const lines = readFileSync(manifest, "utf8").trimEnd().split("\n");
  writeFileSync(manifest, lines.slice(0, 5).join("\n") + "\n");
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(manifest)).digest("hex");
  expectRejectedBeforeExtraction(h, consume(h, digest));
}));

test("import never overlays an existing tree", () => withHarness(h => {
  const { digest } = produce(h);
  mkdirSync(join(h.env.JSC_BUILD_DIR!, "build"), { recursive: true });
  writeFileSync(join(h.env.JSC_BUILD_DIR!, "build/stale"), "stale");
  const result = consume(h, digest);
  expect(result.status).not.toBe(0);
  expect(readdirSync(h.env.JSC_BUILD_DIR!, { recursive: true })).toEqual(["build", "build/stale"]);
  expect(existsSync(join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched"))).toBe(false);
}));

test("import fails when the extracted prebuild does not verify in the consumer's environment", () => withHarness(h => {
  const { digest } = produce(h);
  const result = consume(h, digest, { EXPECTED_STAMP: "consumer-inputs" });
  expect(result.status).toBe(1);
  expect(readFileSync(h.env.STAMP_CALLS!, "utf8")).toBe("stamp\n");
}));

test("packaging fails and reports no digest when a tree is missing or the archiver fails", () => withHarness(h => {
  seedProducerTrees(h);
  rmSync(join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched"), { recursive: true });
  const missing = bash(h, run(producer, packageName));
  expect(missing.status).not.toBe(0);
  expect(readFileSync(h.env.GITHUB_OUTPUT!, "utf8")).toBe("");
  for (const path of [bundle(h), h.env.JSC_BUILD_DIR!, h.env.WASM_TOOLS!]) rmSync(path, { recursive: true, force: true });
  seedProducerTrees(h);
  // tar's own failure must not be hidden by the compressor that ends the pipeline.
  const bin = join(h.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tar"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  const failed = bash(h, run(producer, packageName), { PATH: `${bin}:${h.env.PATH}` });
  expect(failed.status).toBe(2);
  expect(readFileSync(h.env.GITHUB_OUTPUT!, "utf8")).toBe("");
}));
