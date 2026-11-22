import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";
import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { needsJsc, needsRust } from "./ci-changes";
import { excludedJscRoots, excludedJscSentinels, seedJscArtifact } from "./fixtures/jsc-artifact";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

type Job = Readonly<Record<string, unknown>>;

function record(value: unknown): Job {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const source = expandedCiWorkflow();
const jobs = record(record(Bun.YAML.parse(source)).jobs);
const producer = record(jobs["ordinary-build"]);
const checkpoint = record(jobs["native-quality"]);
const runtime = record(jobs.rust);
const jscPrebuildAction = record(record(Bun.YAML.parse(readFileSync(new URL("../.github/actions/jsc-prebuild/action.yml", import.meta.url), "utf8"))).runs);

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

test("ordinary-build provisions the JSC prebuild inline for every native or browser selection without cross-job transfer", () => {
  expect(producer.needs).toBe("selection");
  expect(producer.if).toBe("${{ (github.event_name != 'pull_request' || !github.event.pull_request.draft) && (needs.selection.outputs.rust == 'true' || needs.selection.outputs.browser_guest == 'true') }}");
  expect(runtime.needs).toEqual(["selection", "ordinary-build"]);
  expect(checkpoint.needs).toBe("selection");
  // A native-only change still builds the tools fixture, which links the prebuild.
  for (const [path, jsc] of [["crates/bunwasm-runtime/src/engine_quickjs.rs", false], ["jsc/configure.sh", true], ["scripts/build-jsc.sh", true]] satisfies [string, boolean][]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(jsc);
  }
  expect(needsRust(["docs/code-quality.md"])).toBe(false);
  expect(source).not.toContain("jsc-prebuild.tar");
  expect(source).not.toContain("Import the verified JSC prebuild and sysroot");
});

test("ordinary-build owns the sysroot and JSC prebuild cache inline and verifies before building tools or JSC", () => {
  for (const id of ["sysroot-inputs", "sysroot-cache", "jsc-inputs", "jsc-prebuild-cache", "jsc-producer"]) {
    expect(steps(producer).filter(item => item.id === id)).toHaveLength(1);
  }
  for (const id of ["jsc-prebuild-cache", "jsc-producer"]) {
    expect(steps(checkpoint).filter(item => item.id === id)).toHaveLength(0);
    expect(steps(runtime).filter(item => item.id === id)).toHaveLength(0);
  }
  expect(source.match(/^\s+bash scripts\/build-jsc\.sh$/gm)).toHaveLength(1);
  expect(step(producer, "name", "Save the JSC prebuild cache once per input revision").if)
    .toBe("${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.jsc-producer.outputs.jsc-ready == 'true' && steps.jsc-prebuild-cache.outputs.cache-hit != 'true' }}");
  expect(step(producer, "id", "jsc-producer").env).toEqual({ CI_JSC_PREBUILD_HIT: "${{ steps.jsc-prebuild-cache.outputs.cache-matched-key != '' }}" });
  const names = steps(producer).map(item => String(item.name ?? item.uses ?? ""));
  const prebuildIndex = names.indexOf("Build or verify the JSC prebuild");
  expect(prebuildIndex).toBeGreaterThan(names.indexOf("Build patched WASI sysroot"));
  expect(prebuildIndex).toBeGreaterThan(names.indexOf("Configure private JSC build paths"));
  expect(prebuildIndex).toBeLessThan(names.indexOf("Save the JSC prebuild cache once per input revision"));
  expect(prebuildIndex).toBeLessThan(names.indexOf("Build the single tools fixture in the existing native target"));
});

type Harness = { root: string; repo: string; temp: string; env: Record<string, string> };

function harness(temp = "temp"): Harness {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-handoff-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "jsc"), { recursive: true });
  copyFileSync(new URL("../env.sh", import.meta.url), join(repo, "env.sh"));
  mkdirSync(join(repo, "scripts"));
  copyFileSync(new URL("./ci-jsc-artifact.ts", import.meta.url), join(repo, "scripts/ci-jsc-artifact.ts"));
  return { root, repo, temp: join(root, temp), env: environment(root, temp) };
}

function environment(root: string, temp: string): Record<string, string> {
  const runnerTemp = join(root, temp);
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, RUNNER_TEMP: runnerTemp, TMPDIR: runnerTemp,
    WASM_TOOLS: join(runnerTemp, "wasm-tools"), BUN_WASM_SYSROOT: join(runnerTemp, "wasm-tools/bun-wasm-sysroot-patched"), JSC_BUILD_DIR: join(runnerTemp, "jsc/prebuild"),
    GITHUB_RUN_ID: "4100", GITHUB_SHA: "433aca4ea0d761c23fc1661aa8c636e75dfdd6b3",
    GITHUB_OUTPUT: join(root, "outputs"),
  };
}

function seedProducerTrees(h: Harness) {
  const prebuild = h.env.JSC_BUILD_DIR!;
  const sysroot = join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched");
  const sdk = join(h.env.WASM_TOOLS!, "wasi-sdk/share/wasi-sysroot/include/c++");
  seedJscArtifact(prebuild);
  mkdirSync(join(prebuild, "webkit/.git"), { recursive: true });
  mkdirSync(join(sysroot, "lib/wasm32-wasip1"), { recursive: true });
  mkdirSync(join(sysroot, "include"), { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(prebuild, "build/jsc/.bunwasm-inputs"), "expected-inputs");
  writeFileSync(join(prebuild, "build/jsc/lib/libJavaScriptCore.a"), "archive\0bytes");
  writeFileSync(join(prebuild, "webkit/.git/HEAD"), "3d3257150c40a1aabdc5f8b48d5b33d0413674cb\n");
  writeFileSync(join(prebuild, "jsc.wasm"), "wasm", { mode: 0o755 });
  symlinkSync("lib/libJavaScriptCore.a", join(prebuild, "build/jsc/libJavaScriptCore.link"));
  writeFileSync(join(sysroot, "lib/wasm32-wasip1/libc.a"), "libc");
  writeFileSync(join(sysroot, "bun-wasm-sysroot.json"), '{"receipt":true}');
  symlinkSync(sdk, join(sysroot, "include/c++"), "dir");
  utimesSync(join(prebuild, "build/jsc/lib/libJavaScriptCore.a"), 1_700_000_000, 1_700_000_000);
  writeFileSync(join(h.temp, "jsc-prebuild.log"), "prebuild log\n");
  writeFileSync(h.env.GITHUB_OUTPUT!, "");
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
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], { cwd: h.repo, env: { ...h.env, ...env }, encoding: "utf8", timeout: 20000 });
}

function withHarness(body: (h: Harness) => void) {
  const h = harness();
  try { body(h); }
  finally { rmSync(h.root, { recursive: true, force: true }); }
}

const bundle = (h: Harness) => join(h.temp, "jsc-prebuild-artifact");

test("standalone jsc-prebuild packaging excludes build scratch and preserves qualified trees", () => withHarness(h => {
  seedProducerTrees(h);
  const producerSnapshot = snapshot(h.env.JSC_BUILD_DIR!);
  const expected = producerSnapshot.filter(line => !excludedJscRoots.some(path => line.startsWith(`${path} `) || line.startsWith(`${path}/`)));
  const result = bash(h, run(jscPrebuildAction, packageName));
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(snapshot(h.env.JSC_BUILD_DIR!)).toEqual(producerSnapshot);
  expect(result.stdout).toContain('"excluded_regular_file_bytes":');
  expect(result.stdout).toContain('"jsc_artifact_compressed_bytes":');
  expect(readdirSync(bundle(h)).some(name => name.startsWith("jsc-inventory-"))).toBe(false);
  const digest = /^manifest-sha256=([0-9a-f]{64})\n$/.exec(readFileSync(h.env.GITHUB_OUTPUT!, "utf8"))?.[1];
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  const transfer = join(h.temp, "jsc-prebuild.tar");
  expect(execFileSync("tar", ["--posix", "-tf", transfer], { encoding: "utf8" })).toBe("prebuild.tar.zst\nsysroot.tar.zst\njsc-prebuild.log\nmanifest\n");
  const unpacked = join(h.root, "unpacked");
  mkdirSync(unpacked);
  execFileSync("bash", ["-euo", "pipefail", "-c", `tar --posix -xOf "$1" prebuild.tar.zst | zstd -dc | tar --posix -C "$2" -xf -`, "_", transfer, unpacked]);
  expect(snapshot(join(unpacked, "prebuild"))).toEqual(expected);
  for (const path of excludedJscSentinels) expect(existsSync(join(unpacked, "prebuild", path))).toBe(false);
}));

test("packaging fails and reports no digest when a tree is missing or the archiver fails", () => withHarness(h => {
  seedProducerTrees(h);
  rmSync(join(h.env.WASM_TOOLS!, "bun-wasm-sysroot-patched"), { recursive: true });
  const missing = bash(h, run(jscPrebuildAction, packageName));
  expect(missing.status).not.toBe(0);
  expect(readFileSync(h.env.GITHUB_OUTPUT!, "utf8")).toBe("");
  for (const path of [bundle(h), h.env.JSC_BUILD_DIR!, h.env.WASM_TOOLS!]) rmSync(path, { recursive: true, force: true });
  seedProducerTrees(h);
  const bin = join(h.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tar"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  const failed = bash(h, run(jscPrebuildAction, packageName), { PATH: `${bin}:${h.env.PATH}` });
  expect(failed.status).not.toBe(0);
  expect(readFileSync(h.env.GITHUB_OUTPUT!, "utf8")).toBe("");
  expect(readdirSync(bundle(h)).some(name => name.startsWith("jsc-inventory-"))).toBe(false);
}));
