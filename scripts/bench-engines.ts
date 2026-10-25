import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
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
}

interface Workload {
  name: string;
  precompiled: boolean;
  args: readonly string[];
  output(stdout: string): InnerTimes;
}

interface Execution {
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
}

interface Report {
  schemaVersion: 1;
  date: string;
  method: string;
  environment: Record<string, unknown>;
  engines: Array<EngineBuild & { bytes: number; sha256: string }>;
  launcher: { path: string; bytes: number; sha256: string };
  samples: Sample[];
  summaries: Summary[];
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

export function engineOrder(engines: readonly EngineBuild[], round: number): readonly EngineBuild[] {
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
    };
  }));
}

function execute(adapter: EngineAdapter, request: LaunchRequest): Execution {
  const { command, env } = adapter.launch(request);
  const started = performance.now();
  const child = Bun.spawnSync({ cmd: command, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const wallMs = performance.now() - started;
  const stdout = child.stdout.toString();
  const stderr = child.stderr.toString();
  assert.equal(child.exitCode, 0, `${request.engine.name}/${request.workload.name} failed\n${command.join(" ")}\n${stdout}${stderr}`);
  return {
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
  report: Report;
  output?: string;
}): Promise<void> {
  for (const engine of engineOrder(engineList, round)) {
    const cacheDir = workload.precompiled ? join(context.scratch, "cache", engine.name) : undefined;
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
    runs: { type: "string", default: "7" },
    launcher: { type: "string", default: defaultLauncher() },
    output: { type: "string" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: bun scripts/bench-engines.ts [--engine name=path.wasm ...] [--runs 7] [--launcher path] [--output results.json]");
    return;
  }
  const runs = Number(values.runs);
  assert.ok(Number.isInteger(runs) && runs > 0, "--runs must be a positive integer");
  const engines = parseEngineSpecs(values.engine?.length ? values.engine : [`quickjs=${join(root, "dist/bun.wasm")}`]);
  const launcher = resolve(values.launcher!);
  const output = values.output ? resolve(values.output) : undefined;
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-engine-bench-"));
  const removeSignalHandlers = installCleanup(scratch);
  const report: Report = {
    schemaVersion: 1,
    date: new Date().toISOString(),
    method: "Fresh native bun-wasm launcher process per sample on Wasmtime. Cold runs set BUN_WASM_CACHE_DIR=off. Precompiled runs reuse an isolated per-engine Wasmtime compiled-module cache populated by one unmeasured hello run. Engine order alternates each round. Wall time includes launcher, module loading, Bun bootstrap and guest work. Peak RSS is the child's whole-process Linux maximum resident set size, including native Wasmtime and cold compilation. It is not Wasm linear memory or a GC heap measurement. The large workload is bundled before timing and its bundle bytes and SHA-256 are recorded in the environment.",
    environment: { cpu: cpus()[0]?.model, kernel: release(), bun: Bun.version, runs },
    engines: [],
    launcher: { path: launcher, ...await artifact(launcher) },
    samples: [],
    summaries: [],
  };
  try {
    const fixtureDir = join(scratch, "fixtures");
    await mkdir(fixtureDir, { recursive: true });
    await Bun.write(join(fixtureDir, "hello.ts"), await Bun.file(join(root, "tests/bench/hello.ts")).text());
    await Bun.write(join(fixtureDir, "micro.js"), await Bun.file(join(root, "tests/bench/micro.js")).text());
    report.environment.largeBundle = await bundleLargeWorkload(fixtureDir);
    report.engines = await Promise.all(engines.map(async engine => ({ ...engine, ...await artifact(engine.path) })));
    const adapter = nativeLauncherAdapter(launcher);
    for (const engine of engines) await prepareEngine(engine, adapter, fixtureDir, scratch);
    await persist(report, output);
    for (let round = 0; round < runs; round++) await measureRound(engines, round, { adapter, fixtureDir, scratch, report, output });
    report.summaries = summarize(report.samples, engines);
    await persist(report, output);
    console.log(formatSummaries(report.summaries));
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    await persist(report, output);
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
