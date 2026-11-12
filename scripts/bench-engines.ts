import { assertBalancedRounds, childEnvironment, loadArmRegistry, object, williamsSchedule, type ArmDescriptor, type ArmRegistry } from "./engine-arm-registry.ts";
import { compileDuration, compileRequest, type CompileRequest } from "./engine-compile-observation.ts";
import { programKind, programProfile, verifyProgramSide, type ProgramFiles } from "../src/engine-kind.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { cpus, hostname, loadavg, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const microNames = ["loop", "regexp", "json", "alloc", "strings"] as const;
const microChecksums = ["1534387362", "1431980", "4924030", "1400000", "98799"] as const;
type MicroName = typeof microNames[number];
type InnerTimes = Partial<Record<MicroName, number>>;

interface EngineBuild {
  name: string;
  path: string;
  arm?: ArmDescriptor;
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
  compileMs: number | null;
  status: "pass" | "fail" | "measurement-error";
  error: string | null;
}

interface BlockedExecution {
  startedAt: string;
  command: string[];
  stdout: string;
  stderr: string;
  wallMs: null;
  peakRssBytes: null;
  innerMs: InnerTimes;
  compileMs: null;
  status: "blocked";
  error: string;
}
interface SampleIdentity {
  engine: string;
  workload: string;
  round: number;
  precompiled: boolean;
}

type Sample = (Execution | BlockedExecution) & SampleIdentity;
type MeasuredSample = Execution & SampleIdentity;

interface Summary {
  engine: string;
  workload: string;
  runs: number;
  pass: number;
  fail: number;
  measurementError: number;
  blocked: number;
  notRun: number;
  expected: number | null;
  wallMs: number | null;
  peakRssBytes: number | null;
  compileMs: number | null;
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
  compilePhasePath?: string;
  compileRequest?: CompileRequest;
}

interface EngineAdapter {
  launch(request: LaunchRequest): { command: string[]; env: NodeJS.ProcessEnv };
}

export function nativeLauncherAdapter(launcher: string): EngineAdapter {
  return {
    launch({ engine, workload, fixtureDir, cacheDir, compilePhasePath, compileRequest }) {
      return {
        command: [launcher, "--wasm", engine.path, "--dir", `${fixtureDir}::/`, "--env", "PWD=/"].concat(
          engine.arm ? Object.entries(engine.arm.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]) : [], ["--"], workload.args),
        env: { ...(engine.arm ? childEnvironment(engine.arm, process.env) : process.env), BUN_WASM_CACHE_DIR: cacheDir ?? "off", BUN_WASM_COMPILE_PHASE_PATH: compilePhasePath, BUN_WASM_COMPILE_PHASE_REQUEST: compileRequest ? JSON.stringify(compileRequest) : undefined },
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

export const workloads: readonly Workload[] = [
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
  const rows = williamsSchedule(engines);
  return rows[round % rows.length]!;
}

export function summarize(samples: readonly Sample[], engines: readonly EngineBuild[], rounds?: number): Summary[] {
  return engines.flatMap(engine => workloads.map(workload => {
    const selected = samples.filter(sample => sample.engine === engine.name && sample.workload === workload.name);
    const passed = selected.filter((sample): sample is MeasuredSample => sample.status === "pass");
    const innerMs = Object.fromEntries(microNames.flatMap(name => {
      const values = passed.flatMap(sample => sample.innerMs[name] === undefined ? [] : [sample.innerMs[name]]);
      return values.length ? [[name, median(values)]] : [];
    }));
    return {
      engine: engine.name,
      workload: workload.name,
      runs: selected.length, expected: rounds ?? null, notRun: rounds === undefined ? 0 : rounds - selected.length, blocked: selected.filter(sample => sample.status === "blocked").length,
      pass: passed.length, fail: selected.filter(sample => sample.status === "fail").length, measurementError: selected.filter(sample => sample.status === "measurement-error").length,
      wallMs: distribution(passed.map(sample => sample.wallMs))?.median ?? null,
      peakRssBytes: distribution(passed.map(sample => sample.peakRssBytes))?.median ?? null,
      compileMs: distribution(passed.flatMap(sample => sample.compileMs === null ? [] : [sample.compileMs]))?.median ?? null,
      innerMs,
      wallDistribution: distribution(passed.map(sample => sample.wallMs)),
      innerDistributions: Object.fromEntries(microNames.map(name => [name, distribution(passed.flatMap(sample => sample.innerMs[name] === undefined ? [] : [sample.innerMs[name]]))])),
    };
  }));
}

function execute(adapter: EngineAdapter, request: LaunchRequest): Execution {
  const observationRequest = request.engine.arm && request.compilePhasePath ? compileRequest(request.engine.arm, "launcher", request.compilePhasePath) : undefined;
  const { command, env } = adapter.launch({ ...request, compileRequest: observationRequest });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = Bun.spawnSync({ cmd: command, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const wallMs = performance.now() - started;
  const stdout = child.stdout.toString();
  const stderr = child.stderr.toString();
  const phase = request.compilePhasePath && existsSync(request.compilePhasePath) ? readFileSync(request.compilePhasePath, "utf8") : null;
  const outcome = executionOutcome(child.exitCode, stdout, stderr, request.workload, phase, observationRequest);
  return { startedAt, command, stdout, stderr, wallMs, peakRssBytes: child.resourceUsage.maxRSS, ...outcome };
}

export function executionOutcome(exitCode: number, stdout: string, stderr: string, workload: Pick<Workload, "output">, phase: unknown = null, expectedCompile?: CompileRequest): Pick<Execution, "innerMs" | "compileMs" | "status" | "error"> {
  if (exitCode !== 0) return { innerMs: {}, compileMs: null, status: "fail", error: `launcher exit ${exitCode}: ${stderr}` };
  try {
    const observation: unknown = typeof phase === "string" ? JSON.parse(phase) : phase;
    return { innerMs: workload.output(stdout), compileMs: expectedCompile ? compileDuration(observation, expectedCompile) : parseCompilePhase(observation), status: "pass", error: null };
  } catch (error) {
    return { innerMs: {}, compileMs: null, status: "measurement-error", error: String(error) };
  }
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

export async function bundleLargeWorkload(fixtureDir: string): Promise<{ path: string; bytes: number; sha256: string }> {
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
  const warmup = execute(adapter, { engine, workload, fixtureDir, cacheDir });
  assert.equal(warmup.status, "pass", `cache warmup failed: ${warmup.error}`);
  const entries = await readdir(cacheDir, { recursive: true, withFileTypes: true });
  assert.ok(entries.some(entry => entry.isFile()), `${engine.name} populated its compiled-module cache`);
}

async function prepareEngines(engines: readonly EngineBuild[], adapter: EngineAdapter, fixtureDir: string, scratch: string): Promise<Map<string, string>> {
  const blockers = new Map<string, string>();
  for (const engine of engines) {
    try { await prepareEngine(engine, adapter, fixtureDir, scratch); }
    catch (error) { blockers.set(engine.name, `Precompiled cache warmup unavailable: ${String(error)}`); }
  }
  return blockers;
}

async function measureWorkload(engineList: readonly EngineBuild[], workload: Workload, round: number, context: {
  adapter: EngineAdapter;
  fixtureDir: string;
  scratch: string;
  nativeControl: boolean;
  precompiledBlockers: ReadonlyMap<string, string>;
  report: Report;
  output?: string;
}): Promise<void> {
  for (const engine of engineOrder(engineList, round)) {
    const cacheDir = workload.precompiled && !context.nativeControl ? join(context.scratch, "cache", engine.name) : undefined;
    const compilePhasePath = join(context.scratch, `${engine.name}-${workload.name}-${round}.compile.json`);
    const sample = nativeMeasurementCell(context.adapter, { engine, workload, fixtureDir: context.fixtureDir, cacheDir, compilePhasePath }, round, workload.precompiled ? context.precompiledBlockers.get(engine.name) : undefined);
    context.report.samples.push(sample);
    await persist(context.report, context.output);
    console.error(`${engine.name}/${workload.name} round ${round + 1}: ${sample.status}, ${sample.wallMs?.toFixed(2) ?? "unavailable"} ms`);
  }
}

async function measureRound(engineList: readonly EngineBuild[], round: number, context: Parameters<typeof measureWorkload>[3]): Promise<void> {
  for (const workload of workloads) await measureWorkload(engineList, workload, round, context);
}

export function formatSummaries(summaries: readonly Summary[]): string {
  const lines = [
    "| Engine | Workload | Runs | Median wall ms | Median peak RSS MiB |",
    "| --- | --- | ---: | ---: | ---: |",
    ...summaries.map(summary => `| ${summary.engine} | ${summary.workload} | ${summary.runs} | ${summary.wallMs?.toFixed(2) ?? "not-run"} | ${(summary.peakRssBytes === null ? "not-run" : (summary.peakRssBytes / 1024 ** 2).toFixed(2))} |`),
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

async function initialReport(launcher: string, runs: number, nativeControl: boolean): Promise<Report> {
  return {
    schemaVersion: 2,
    date: new Date().toISOString(),
    method: nativeControl ? "Runner validation only on native Bun. Fresh process per sample; cold/precompiled names are workload IDs and do not imply Wasm cache or engine measurements." : "Fresh native bun-wasm launcher per sample. Cold disables Wasmtime compilation cache; precompiled reuses a per-engine cache warmed once. No OS cache flush or warm JS VM. Arm order uses complete Williams blocks. Four native arms use eight rounds by default, two four-round blocks. Compile time is null unless the launcher records an explicit compile phase. Wall includes launch, bootstrap and guest work. Peak RSS includes Wasmtime and compilation, not guest heap. Fixtures are bundled and hashed before timing. Experimental evidence, no default decision.",
    environment: { host: hostname(), platform: platform(), cpu: cpus()[0]?.model, kernel: release(), bun: Bun.version, runs, loadBefore: loadavg(),
      bootId: await readFile("/proc/sys/kernel/random/boot_id", "utf8").then(text => text.trim(), () => null), source: gitIdentity(),
      memory: { nativePeakRss: "whole process including inherited harness footprint at fork, Wasmtime and compiler; diagnostic only, not guest heap", capacity: null, allocatorLive: null, allocatorPeak: null, engineHeap: null, backingStores: null, swc: null } },
    engines: [],
    launcher: { path: launcher, ...await artifact(launcher) },
    samples: [],
    summaries: [],
    scope: nativeControl ? "native-control-only" : "experimental-wasm",
    registration: null,
  };
}

async function createRegistration(report: Report, registry: ArmRegistry | undefined, fixtureDir: string, options: { engines: readonly EngineBuild[]; runs: number; protocol?: string; producerManifest?: string }) {
  const fixturePaths = ["hello.ts", "micro.js", "large-bundle.js"].map(name => join(fixtureDir, name));
  return {
      unavailableArms: registry ? ["browser:unavailable-native"] : [], armRegistry: registry ?? null, registeredAt: new Date().toISOString(), argv: process.argv, scope: report.scope, engines: report.engines, launcher: report.launcher, environment: structuredClone(report.environment),
      protocol: options.protocol ? await identity(resolve(options.protocol)) : null,
      producerManifest: options.producerManifest ? { ...await identity(resolve(options.producerManifest)), content: await Bun.file(options.producerManifest).json(), verification: "Producer verifier must pass before this invocation; this runner does not reimplement its schema" } : null,
      fixtures: await Promise.all(fixturePaths.concat([join(root, "bun.lock"), join(root, "tests/bench/large-bundle.ts"), import.meta.filename]).map(identity)),
      workloads: workloads.map(({ output: _output, ...workload }) => workload),
      order: Array.from({ length: options.runs }, (_, round) => engineOrder(options.engines, round).map(engine => engine.name)),
      analysis: "Keep all valid samples; min/median/nearest-rank-p90/max/MAD; flag n<6 or relative MAD>10%; no default decision",
    };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    engine: { type: "string", multiple: true },
    host: { type: "string", default: "native" },
    url: { type: "string" },
    runs: { type: "string" },
    registry: { type: "string" },
    launcher: { type: "string" },
    output: { type: "string" },
    protocol: { type: "string" },
    "producer-manifest": { type: "string" },
    "native-control": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: bun scripts/bench-engines.ts [--host native|chromium] [--url http://admitted-playground/] [--registry admitted-registry.json] [--runs 8] [--launcher path] [--output NEW.json] [--protocol protocol.md] [--producer-manifest manifest.json] [--native-control]");
    return;
  }
  assert.ok(values.host === "native" || values.host === "chromium", "--host must be native or chromium");
  if (values.host === "chromium") return chromiumMain(values);
  assert.ok(!values.url, "--url requires --host chromium");
  assert.ok(values["native-control"] || values.registry, "Wasm measurement requires --registry with same-source admission and Browser receipt");
  assert.ok(!values.registry || (!values.engine?.length && !values["native-control"]), "registry owns arm selection");
  const registry = values.registry ? await loadArmRegistry(resolve(values.registry)) : undefined;
  const runs = Number(values.runs ?? registry?.nativeRounds ?? 6);
  assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 36, "--runs must be an integer from 1 to 36");
  assert.ok(!values["native-control"] || !values.engine?.length, "native controls cannot carry engine labels");
  const launcher = values["native-control"] ? process.execPath : resolve(values.launcher ?? registry?.launcher.path ?? defaultLauncher());
  const engines = registry ? nativeRegistryBuilds(registry) : [{ name: "native-bun-control", path: launcher }];
  if (registry) assertBalancedRounds(runs, engines.length);
  if (registry) assert.equal(launcher, registry.launcher.path, "launcher differs from admitted generation");
  const output = values.output ? resolve(values.output) : undefined;
  if (output) {
    assert.equal(await Bun.file(output).exists(), false, "choose a new output identity");
    assert.equal(await Bun.file(`${output}.protocol.json`).exists(), false, "choose a new registration identity");
  }
  const report = await initialReport(launcher, runs, values["native-control"]);
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
    for (const engine of report.engines) if (engine.arm) assert.deepEqual(engine.program, engine.arm.program, "launcher program differs from admitted arm");
    report.registration = await createRegistration(report, registry, fixtureDir, { engines, runs, protocol: values.protocol, producerManifest: values["producer-manifest"] });
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(`${output}.protocol.json`, `${JSON.stringify(report.registration, null, 2)}\n`, { flag: "wx" });
    }
    registered = true;
    if (!output) console.log(JSON.stringify({ registration: report.registration }));
    const adapter = values["native-control"] ? nativeControlAdapter(launcher) : nativeLauncherAdapter(launcher);
    const precompiledBlockers = values["native-control"] ? new Map<string, string>() : await prepareEngines(engines, adapter, fixtureDir, scratch);
    await persist(report, output);
    for (let round = 0; round < runs; round++) await measureRound(engines, round, { adapter, fixtureDir, scratch, report, output, precompiledBlockers, nativeControl: values["native-control"] });
    report.environment.loadAfter = loadavg();
    if (report.samples.some(sample => sample.status !== "pass")) report.error = "One or more registered samples failed; none were dropped";
    report.summaries = summarize(report.samples, engines, runs);
    await persist(report, output);
    console.log(formatSummaries(report.summaries));
    if (report.error) process.exitCode = 1;
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    report.summaries = summarize(report.samples, engines, runs);
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

export function nativeRegistryBuilds(registry: ArmRegistry): EngineBuild[] {
  return registry.nativeArms.map(arm => {
    assert.notEqual(arm.program.kind, "single", "Browser is unavailable natively");
    if (arm.program.kind !== "single") assert.equal(arm.program.side.path, join(dirname(arm.program.core.path), programProfile(arm.program.kind).side), "launcher must load the admitted side path");
    return { name: arm.label, path: arm.program.core.path, arm };
  });
}

// Only a dedicated host-written file outside the guest mount can attribute a
// compile phase. Guest stderr and page-to-ready wall time are not that evidence.
// The current launcher has no emitter, so its compile measurement stays null.
export function parseCompilePhase(value: unknown): number | null {
  if (value === null) return null;
  const phase = object(value);
  assert.equal(phase.schemaVersion, 1, "unknown compile phase schema");
  assert.equal(phase.source, "launcher", "phase must come from the launcher");
  assert.equal(phase.phase, "module-compilation", "not a compile phase");
  assert.equal(phase.clock, "monotonic", "phase must use monotonic time");
  assert.ok(typeof phase.durationMs === "number" && Number.isFinite(phase.durationMs) && phase.durationMs >= 0, "invalid compile duration");
  return phase.durationMs;
}

async function chromiumMain(values: { registry?: string; url?: string; output?: string; runs?: string; launcher?: string; engine?: string[]; "native-control"?: boolean; protocol?: string; "producer-manifest"?: string }) {
  assert.ok(values.registry && values.url && values.output, "Chromium measurement requires --registry, --url and --output");
  assert.ok(!values["native-control"] && !values.engine && !values.launcher && !values.runs && !values.protocol && !values["producer-manifest"], "Chromium registry owns arms and rounds; native options do not apply");
  const registry = await loadArmRegistry(resolve(values.registry));
  assert.equal(await Bun.file(values.output).exists(), false, "choose a new output identity");
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-chromium-fixtures-"));
  try {
    const large = await bundleLargeWorkload(scratch);
    const files = { "/home/user/hello.ts": await readFile(join(root, "tests/bench/hello.ts"), "utf8"),
      "/home/user/micro.js": await readFile(join(root, "tests/bench/micro.js"), "utf8"), "/home/user/large-bundle.js": await readFile(large.path, "utf8") };
    const selected = workloads.map(workload => ({ name: workload.name, files,
      command: "bun " + workload.args.map(arg => `'${(arg.startsWith("/") ? `/home/user${arg}` : arg).replaceAll("'", "'\\''")}'`).join(" "),
      check(stdout: string) { workload.output(stdout); } }));
    const { runChromiumBenchmark } = await import("./engine-chromium-bench.ts");
    await runChromiumBenchmark(registry, values.url, resolve(values.output), selected);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function nativeMeasurementCell(adapter: EngineAdapter, request: LaunchRequest, round: number, blocker?: string): Sample {
  const cell = { engine: request.engine.name, workload: request.workload.name, round, precompiled: request.workload.precompiled };
  try {
    if (blocker) return { ...cell, ...blockedExecution(blocker) };
    return { ...cell, ...execute(adapter, request) };
  } catch (error) {
    return { ...cell, ...blockedExecution(String(error)) };
  }
}
function blockedExecution(error: string): BlockedExecution {
  return { status: "blocked", error, startedAt: new Date().toISOString(), command: [], stdout: "", stderr: "", wallMs: null, peakRssBytes: null, innerMs: {}, compileMs: null };
}
