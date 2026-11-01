import { programKind, programProfile, verifyProgramSide, type ProgramFiles, type Engine } from "../src/engine-kind.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { cpus, hostname, loadavg, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const defaultEngine: Engine = "quickjs";
const microNames = ["loop", "regexp", "json", "alloc", "strings"] as const;
const microChecksums = ["1534387362", "1431980", "4924030", "1400000", "98799"] as const;
type MicroName = typeof microNames[number];
type InnerTimes = Partial<Record<MicroName, number>>;

interface EngineBuild {
  name: string;
  path: string;
}

interface Workload {
  name: string;
  precompiled: boolean;
  args: readonly string[];
  output(stdout: string): InnerTimes;
}

interface Execution {
  startedAt: string;
  command: string[];
  stdout: string;
  stderr: string;
  wallMs: number;
  peakRssBytes: number;
  innerMs: InnerTimes;
}

interface Sample extends Execution {
  engine: string;
  workload: string;
  round: number;
  precompiled: boolean;
}

interface Summary {
  engine: string;
  workload: string;
  runs: number;
  wallMs: number;
  peakRssBytes: number;
  innerMs: InnerTimes;
  wallDistribution: ReturnType<typeof distribution>;
  innerDistributions: Partial<Record<MicroName, ReturnType<typeof distribution>>>;
}

interface Report {
  schemaVersion: 2;
  date: string;
  method: string;
  environment: Record<string, unknown>;
  engines: Array<EngineBuild & { program: ProgramFiles<{ path: string; bytes: number; sha256: string }> | null }>;
  launcher: { path: string; bytes: number; sha256: string };
  samples: Sample[];
  summaries: Summary[];
  scope: "experimental-wasm" | "native-control-only";
  registration: unknown;
  error?: string;
}

interface LaunchRequest {
  engine: EngineBuild;
  workload: Workload;
  fixtureDir: string;
  cacheDir?: string;
}

interface EngineAdapter {
  launch(request: LaunchRequest): { command: string[]; env: NodeJS.ProcessEnv };
}

export function nativeLauncherAdapter(launcher: string): EngineAdapter {
  return {
    launch({ engine, workload, fixtureDir, cacheDir }) {
      return {
        command: [launcher, "--wasm", engine.path, "--dir", `${fixtureDir}::/`, "--env", "PWD=/", "--", ...workload.args],
        env: { ...process.env, BUN_WASM_CACHE_DIR: cacheDir ?? "off" },
      };
    },
  };
}

export function nativeControlAdapter(launcher: string): EngineAdapter {
  return {
    launch({ workload, fixtureDir }) {
      return { command: [launcher].concat(workload.args.map(arg => arg.startsWith("/") ? join(fixtureDir, arg) : arg)), env: { ...process.env } };
    },
  };
}

function exactOutput(expected: string): (stdout: string) => InnerTimes {
  return stdout => {
    assert.equal(stdout.trim(), expected);
    return {};
  };
}

export function parseMicroOutput(stdout: string): InnerTimes {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, microNames.length, "micro suite prints five results");
  return Object.fromEntries(lines.map((line, index) => {
    const match = line.match(/^(\w+)\s+(\d+) ms\s+\((\d+)\)$/);
    assert.ok(match, `invalid micro output: ${line}`);
    assert.equal(match[1], microNames[index]);
    assert.equal(match[3], microChecksums[index], `${match[1]} checksum`);
    return [match[1], Number(match[2])];
  }));
}

function parseLargeOutput(stdout: string): InnerTimes {
  assert.match(stdout.trim(), /^large-bundle \S+ statements=1$/);
  return {};
}

const workloads: readonly Workload[] = [
  { name: "hello-cold", precompiled: false, args: ["run", "/hello.ts"], output: exactOutput("hello") },
  { name: "hello-precompiled", precompiled: true, args: ["run", "/hello.ts"], output: exactOutput("hello") },
  { name: "eval-precompiled", precompiled: true, args: ["-e", 'console.log("eval-ok")'], output: exactOutput("eval-ok") },
  { name: "micro-precompiled", precompiled: true, args: ["run", "/micro.js"], output: parseMicroOutput },
  { name: "large-bundle-precompiled", precompiled: true, args: ["run", "/large-bundle.js"], output: parseLargeOutput },
];

export function parseEngineSpecs(specs: readonly string[]): EngineBuild[] {
  const engines = specs.map(spec => {
    const separator = spec.indexOf("=");
    const name = separator < 0 ? basename(spec, ".wasm") : spec.slice(0, separator);
    const path = separator < 0 ? spec : spec.slice(separator + 1);
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, `invalid engine name in ${spec}`);
    assert.ok(path, `missing engine path in ${spec}`);
    return { name, path: resolve(path) };
  });
  assert.equal(new Set(engines.map(engine => engine.name)).size, engines.length, "engine names must be unique");
  return engines;
}

export function median(values: readonly number[]): number {
  assert.ok(values.length > 0, "median needs samples");
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function distribution(values: readonly number[]) {
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0), "timings must be finite and nonnegative");
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = median(sorted);
  const mad = median(sorted.map(value => Math.abs(value - middle)));
  return { n: sorted.length, min: sorted[0]!, median: middle, p90: sorted[Math.ceil(sorted.length * 0.9) - 1]!, max: sorted.at(-1)!, mad,
    flags: (sorted.length < 6 ? ["fewer-than-six"] : []).concat(middle > 0 && mad / middle > 0.1 ? ["relative-mad-above-10-percent"] : []) };
}

export function engineOrder(engines: readonly EngineBuild[], round: number): readonly EngineBuild[] {
  if (engines.length === 3) {
    const orders = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [1, 0, 2], [0, 2, 1]];
    return orders[round % orders.length]!.map(index => engines[index]!);
  }
  return round % 2 ? engines.toReversed() : engines;
}

export function summarize(samples: readonly Sample[], engines: readonly EngineBuild[]): Summary[] {
  return engines.flatMap(engine => workloads.map(workload => {
    const selected = samples.filter(sample => sample.engine === engine.name && sample.workload === workload.name);
    const innerMs = Object.fromEntries(microNames.flatMap(name => {
      const values = selected.flatMap(sample => sample.innerMs[name] === undefined ? [] : [sample.innerMs[name]]);
      return values.length ? [[name, median(values)]] : [];
    }));
    return {
      engine: engine.name,
      workload: workload.name,
      runs: selected.length,
      wallMs: median(selected.map(sample => sample.wallMs)),
      peakRssBytes: median(selected.map(sample => sample.peakRssBytes)),
      innerMs,
      wallDistribution: distribution(selected.map(sample => sample.wallMs)),
      innerDistributions: Object.fromEntries(microNames.map(name => [name, distribution(selected.flatMap(sample => sample.innerMs[name] === undefined ? [] : [sample.innerMs[name]]))])),
    };
  }));
}

function execute(adapter: EngineAdapter, request: LaunchRequest): Execution {
  const { command, env } = adapter.launch(request);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = Bun.spawnSync({ cmd: command, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const wallMs = performance.now() - started;
  const stdout = child.stdout.toString();
  const stderr = child.stderr.toString();
  assert.equal(child.exitCode, 0, `${request.engine.name}/${request.workload.name} failed\n${command.join(" ")}\n${stdout}${stderr}`);
  return {
    startedAt,
    command,
    stdout,
    stderr,
    wallMs,
    peakRssBytes: child.resourceUsage.maxRSS,
    innerMs: request.workload.output(stdout),
  };
}

async function artifact(path: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path);
  assert.ok((await stat(path)).isFile(), `${path} is a file`);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function identity(path: string) { return { path, ...await artifact(path) }; }

function gitIdentity(): { head: string; tree: string; dirty: boolean } {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root].concat(args), { stdout: "pipe", stderr: "pipe" });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString().trim();
  };
  return { head: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), dirty: git(["status", "--porcelain"]).length > 0 };
}

export async function engineArtifacts(path: string): Promise<ProgramFiles<{ path: string; bytes: number; sha256: string }>> {
  const bytes = await readFile(path);
  const kind = programKind(new WebAssembly.Module(bytes));
  const core = { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  if (kind === "single") return { kind, core };
  const sidePath = join(dirname(path), programProfile(kind).side);
  const sideBytes = await readFile(sidePath);
  verifyProgramSide(kind, new WebAssembly.Module(sideBytes));
  return { kind, core, side: { path: sidePath, bytes: sideBytes.length, sha256: createHash("sha256").update(sideBytes).digest("hex") } };
}

async function persist(report: Report, output?: string): Promise<void> {
  if (!output) return;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}

async function bundleLargeWorkload(fixtureDir: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const result = await Bun.build({
    entrypoints: [join(root, "tests/bench/large-bundle.ts")],
    target: "bun",
    format: "esm",
  });
  assert.ok(result.success, result.logs.map(log => log.toString()).join("\n"));
  assert.equal(result.outputs.length, 1, "large benchmark is one self-contained bundle");
  const path = join(fixtureDir, "large-bundle.js");
  await Bun.write(path, result.outputs[0]!);
  return { path, ...await artifact(path) };
}

async function prepareEngine(engine: EngineBuild, adapter: EngineAdapter, fixtureDir: string, scratch: string): Promise<void> {
  const cacheDir = join(scratch, "cache", engine.name);
  await mkdir(cacheDir, { recursive: true });
  const workload = workloads.find(candidate => candidate.name === "hello-precompiled")!;
  execute(adapter, { engine, workload, fixtureDir, cacheDir });
  const entries = await readdir(cacheDir, { recursive: true, withFileTypes: true });
  assert.ok(entries.some(entry => entry.isFile()), `${engine.name} populated its compiled-module cache`);
}

async function measureWorkload(engineList: readonly EngineBuild[], workload: Workload, round: number, context: {
  adapter: EngineAdapter;
  fixtureDir: string;
  scratch: string;
  nativeControl: boolean;
  report: Report;
  output?: string;
}): Promise<void> {
  for (const engine of engineOrder(engineList, round)) {
    const cacheDir = workload.precompiled && !context.nativeControl ? join(context.scratch, "cache", engine.name) : undefined;
    const execution = execute(context.adapter, { engine, workload, fixtureDir: context.fixtureDir, cacheDir });
    context.report.samples.push({ ...execution, engine: engine.name, workload: workload.name, round, precompiled: workload.precompiled });
    await persist(context.report, context.output);
    console.error(`${engine.name}/${workload.name} round ${round + 1}: ${execution.wallMs.toFixed(2)} ms, ${(execution.peakRssBytes / 1024 ** 2).toFixed(2)} MiB`);
  }
}

async function measureRound(engineList: readonly EngineBuild[], round: number, context: Parameters<typeof measureWorkload>[3]): Promise<void> {
  for (const workload of workloads) await measureWorkload(engineList, workload, round, context);
}

export function formatSummaries(summaries: readonly Summary[]): string {
  const lines = [
    "| Engine | Workload | Runs | Median wall ms | Median peak RSS MiB |",
    "| --- | --- | ---: | ---: | ---: |",
    ...summaries.map(summary => `| ${summary.engine} | ${summary.workload} | ${summary.runs} | ${summary.wallMs.toFixed(2)} | ${(summary.peakRssBytes / 1024 ** 2).toFixed(2)} |`),
  ];
  const micro = summaries.filter(summary => summary.workload === "micro-precompiled");
  lines.push("", "| Engine | Guest loop ms | RegExp ms | JSON ms | Alloc/Maps ms | Strings/sort ms |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  lines.push(...micro.map(summary => `| ${summary.engine} | ${microNames.map(name => summary.innerMs[name]?.toFixed(0) ?? "-").join(" | ")} |`));
  return lines.join("\n");
}

function defaultLauncher(): string {
  const configured = process.env.BUN_WASM_LAUNCHER ?? Bun.which("bun-wasm");
  if (configured) return resolve(configured);
  assert.ok(process.env.CARGO_TARGET_DIR, "set BUN_WASM_LAUNCHER or source env.sh");
  return resolve(process.env.CARGO_TARGET_DIR, "release/bun-wasm");
}

function installCleanup(scratch: string): () => void {
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const interrupt = () => { cleanup(); process.exit(130); };
  const terminate = () => { cleanup(); process.exit(143); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  return () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    engine: { type: "string", multiple: true },
    runs: { type: "string", default: "6" },
    launcher: { type: "string", default: defaultLauncher() },
    output: { type: "string" },
    protocol: { type: "string" },
    "producer-manifest": { type: "string" },
    "native-control": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: bun scripts/bench-engines.ts [--engine name=path.wasm ...] [--runs 6] [--launcher path] [--output NEW.json] [--protocol protocol.md] [--producer-manifest manifest.json] [--native-control]");
    return;
  }
  const runs = Number(values.runs);
  assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 36, "--runs must be an integer from 1 to 36");
  assert.ok(!values["native-control"] || !values.engine?.length, "native controls cannot carry engine labels");
  const launcher = values["native-control"] ? process.execPath : resolve(values.launcher!);
  const engines = values["native-control"] ? [{ name: "native-bun-control", path: launcher }] : parseEngineSpecs(values.engine?.length ? values.engine : [`${defaultEngine}=${join(root, "dist/bun.wasm")}`]);
  assert.ok(engines.length <= 3, "bounded comparison supports at most three engines");
  assert.ok(engines.length !== 3 || runs % 6 === 0, "three-engine comparisons need complete six-round blocks");
  const output = values.output ? resolve(values.output) : undefined;
  if (output) {
    assert.equal(await Bun.file(output).exists(), false, "choose a new output identity");
    assert.equal(await Bun.file(`${output}.protocol.json`).exists(), false, "choose a new registration identity");
  }
  const report: Report = {
    schemaVersion: 2,
    date: new Date().toISOString(),
    method: values["native-control"] ? "Runner validation only on native Bun. Fresh process per sample; cold/precompiled names are workload IDs and do not imply Wasm cache or engine measurements." : "Fresh native bun-wasm launcher per sample. Cold disables Wasmtime compilation cache; precompiled reuses a per-engine cache warmed once. No OS cache flush or warm JS VM. Three engines use all six permutations; two alternate. Wall includes launch, bootstrap and guest work. Peak RSS includes Wasmtime and compilation, not guest heap. Fixtures are bundled and hashed before timing. Experimental evidence, no default decision.",
    environment: { host: hostname(), platform: platform(), cpu: cpus()[0]?.model, kernel: release(), bun: Bun.version, runs, loadBefore: loadavg(),
      bootId: await readFile("/proc/sys/kernel/random/boot_id", "utf8").then(text => text.trim(), () => null), source: gitIdentity(),
      memory: { nativePeakRss: "whole process including inherited harness footprint at fork, Wasmtime and compiler; diagnostic only, not guest heap", capacity: null, allocatorLive: null, allocatorPeak: null, engineHeap: null, backingStores: null, swc: null } },
    engines: [],
    launcher: { path: launcher, ...await artifact(launcher) },
    samples: [],
    summaries: [],
    scope: values["native-control"] ? "native-control-only" : "experimental-wasm",
    registration: null,
  };
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-engine-bench-"));
  const removeSignalHandlers = installCleanup(scratch);
  let registered = false;
  try {
    const fixtureDir = join(scratch, "fixtures");
    await mkdir(fixtureDir, { recursive: true });
    await Bun.write(join(fixtureDir, "hello.ts"), await Bun.file(join(root, "tests/bench/hello.ts")).text());
    await Bun.write(join(fixtureDir, "micro.js"), await Bun.file(join(root, "tests/bench/micro.js")).text());
    report.environment.largeBundle = await bundleLargeWorkload(fixtureDir);
    report.engines = await Promise.all(engines.map(async engine => ({ ...engine, program: values["native-control"] ? null : await engineArtifacts(engine.path) })));
    const fixturePaths = ["hello.ts", "micro.js", "large-bundle.js"].map(name => join(fixtureDir, name));
    report.registration = {
      registeredAt: new Date().toISOString(), argv: process.argv, scope: report.scope, engines: report.engines, launcher: report.launcher, environment: structuredClone(report.environment),
      protocol: values.protocol ? await identity(resolve(values.protocol)) : null,
      producerManifest: values["producer-manifest"] ? { ...await identity(resolve(values["producer-manifest"])), content: await Bun.file(values["producer-manifest"]).json(), verification: "Producer verifier must pass before this invocation; this runner does not reimplement its schema" } : null,
      fixtures: await Promise.all(fixturePaths.concat([join(root, "bun.lock"), join(root, "tests/bench/large-bundle.ts"), import.meta.filename]).map(identity)),
      workloads: workloads.map(({ output: _output, ...workload }) => workload),
      order: Array.from({ length: runs }, (_, round) => engineOrder(engines, round).map(engine => engine.name)),
      analysis: "Keep all valid samples; min/median/nearest-rank-p90/max/MAD; flag n<6 or relative MAD>10%; no default decision",
    };
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(`${output}.protocol.json`, `${JSON.stringify(report.registration, null, 2)}\n`, { flag: "wx" });
    }
    registered = true;
    if (!output) console.log(JSON.stringify({ registration: report.registration }));
    const adapter = values["native-control"] ? nativeControlAdapter(launcher) : nativeLauncherAdapter(launcher);
    if (!values["native-control"]) for (const engine of engines) await prepareEngine(engine, adapter, fixtureDir, scratch);
    await persist(report, output);
    for (let round = 0; round < runs; round++) await measureRound(engines, round, { adapter, fixtureDir, scratch, report, output, nativeControl: values["native-control"] });
    report.environment.loadAfter = loadavg();
    report.summaries = summarize(report.samples, engines);
    await persist(report, output);
    console.log(formatSummaries(report.summaries));
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    if (registered) await persist(report, output);
    throw error;
  } finally {
    removeSignalHandlers();
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
