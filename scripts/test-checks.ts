import { spawn, spawnSync } from "node:child_process";
import { availableParallelism, constants } from "node:os";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const owners = ["runtime", "web", "quality", "package-extra", "cmake", "web-browser", "browser-guest", "native", "native-probe"] as const;
type Owner = typeof owners[number];
const batchOwners = new Set<Owner>(["web", "browser-guest", "web-browser"]);
export type NativeProfile = "split" | "shared-group";
const nativeEngines = ["quickjs", "jsc", "browser", "spidermonkey"] as const;
export type NativeEngine = typeof nativeEngines[number];
type NativeSelection = { profile: "shared-group"; engines?: never } | { profile?: never; engines?: readonly NativeEngine[] };
type Check = { path: string; localRuntime: boolean; batch: string; entry?: string; isolation?: "process" } & (
  | { owner: "native-probe"; inputs: string[] }
  | ({ owner: "native"; inputs?: never } & NativeSelection)
  | { owner: "browser-guest"; profile?: "shared-group"; inputs: string[] }
  | { owner: "runtime"; inputs: string[]; profile?: never }
  | { owner: Exclude<Owner, "native-probe" | "native" | "browser-guest" | "runtime">; inputs?: never; profile?: never }
);
const root = resolve(import.meta.dir, "..");

/** Owners whose checks consume a matching shared-group producer when a manifest selects one. */
function hasProfile(owner: string): boolean {
  return owner === "native" || owner === "browser-guest";
}

function parseOwner(value: unknown): Owner {
  for (const owner of owners) if (value === owner) return owner;
  throw new Error(`Unknown check owner: ${String(value)}`);
}

/**
 * A check is one execution: its owner, profile, path and, for a native shared-group fixture
 * with more than one command, the entry that names the command. Its id is the path, or
 * `path#entry`. Everything from discovery to the result label carries the id, because a path
 * alone cannot tell two commands of one fixture apart.
 */
export function checkId(check: { path: string; entry?: string }): string {
  return check.entry === undefined ? check.path : `${check.path}#${check.entry}`;
}

export function parseCheckId(id: string): { path: string; entry?: string } {
  const at = id.indexOf("#");
  if (at < 0) return { path: id };
  return { path: id.slice(0, at), entry: entryName(id.slice(at + 1), id) };
}

/** Lowercase words joined by single hyphens: nothing that leaves the fixture or means something to a shell. */
function entryName(value: unknown, file: string): string {
  if (typeof value !== "string" || value.length > 32 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`Unsafe check entry: ${file}`);
  return value;
}

/** The command and expected-output files of a fixture's default command or of a named entry. */
export function entryFiles(entry?: string): { command: string; expected: string } {
  return entry === undefined ? { command: "cmd", expected: "expected.txt" } : { command: `cmd.${entry}`, expected: `expected.${entry}.txt` };
}

function sharedNative(check: Check): boolean {
  return check.owner === "native" && check.profile === "shared-group";
}

function inputFiles(inputs: unknown, file: string): string[] {
  if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every(input => typeof input === "string" && /^[a-zA-Z0-9_.+-]+(?:\/[a-zA-Z0-9_.+-]+)*$/.test(input) && !input.split("/").includes(".."))) throw new Error(`Invalid check input files: ${file}`);
  if (new Set(inputs).size !== inputs.length) throw new Error(`Duplicate check inputs: ${file}`);
  return inputs;
}

function isNativeEngine(value: unknown): value is NativeEngine {
  return value === "quickjs" || value === "jsc" || value === "browser" || value === "spidermonkey";
}

function engineSubset(engines: unknown, source: string): readonly NativeEngine[] {
  if (!Array.isArray(engines) || engines.length === 0 || !engines.every(isNativeEngine) || new Set(engines).size !== engines.length) throw new Error(`Invalid native engines: ${source}`);
  return engines;
}

function nativeSelection(value: object, profile: NativeProfile, file: string): NativeSelection {
  if (!("engines" in value)) return profile === "shared-group" ? { profile } : {};
  if (profile !== "split") throw new Error(`Only split native checks select engines: ${file}`);
  return { engines: engineSubset(value.engines, file) };
}

export function nativeProducerEngines(env = process.env): readonly NativeEngine[] {
  return env.BUN_WASM_CHECK_ENGINES === undefined ? nativeEngines : engineSubset(env.BUN_WASM_CHECK_ENGINES.split(","), "BUN_WASM_CHECK_ENGINES");
}

function runtimeIsolation(value: object, owner: Owner, file: string): Pick<Check, "isolation"> {
  if (!("isolation" in value)) return {};
  if (owner !== "runtime" || value.isolation !== "process") throw new Error(`Invalid runtime isolation: ${file}`);
  return { isolation: "process" };
}

export function parseCheck(value: unknown, file: string): Check {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid check: ${file}`);
  if (!("owner" in value) || !("path" in value)) throw new Error(`Missing check fields: ${file}`);
  if (Object.keys(value).some(key => !["owner", "path", "localRuntime", "batch", "inputs", "profile", "entry", "engines", "isolation"].includes(key))) throw new Error(`Unknown check fields: ${file}`);
  const owner = parseOwner(value.owner);
  const isolation = runtimeIsolation(value, owner, file);
  if ("engines" in value && owner !== "native") throw new Error(`Only split native checks select engines: ${file}`);
  if ("profile" in value && !hasProfile(owner)) throw new Error(`Only native and browser-guest checks select a profile: ${file}`);
  const profile = "profile" in value ? nativeProfile(value.profile) : "split";
  if ("entry" in value && (owner !== "native" || profile !== "shared-group")) throw new Error(`Only native shared-group checks name an entry: ${file}`);
  const entry = "entry" in value ? entryName(value.entry, file) : undefined;
  if (!file.startsWith(`${owner}-`)) throw new Error(`Owner must match manifest prefix: ${file}`);
  const path = value.path;
  const pattern = owner === "native" ? /^tests\/fixtures\/[a-z0-9][a-z0-9-]*$/ : /^scripts\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/;
  if (typeof path !== "string" || !pattern.test(path)) throw new Error(`Unsafe check path: ${file}`);
  const localRuntime = "localRuntime" in value ? value.localRuntime : false;
  if (typeof localRuntime !== "boolean" || (localRuntime && owner !== "runtime" && owner !== "web")) throw new Error(`Invalid local runtime selection: ${file}`);
  const batch = "batch" in value ? value.batch : "default";
  if (typeof batch !== "string" || (batch !== "default" && (!batchOwners.has(owner) || !/^[0-9]{2}-[a-z0-9-]+$/.test(batch)))) throw new Error(`Invalid check batch: ${file}`);
  if (owner === "browser-guest") {
    const inputs = "inputs" in value ? inputFiles(value.inputs, file) : [];
    if (profile === "shared-group") return { owner, path, localRuntime, batch, profile, inputs };
    return { owner, path, localRuntime, batch, inputs };
  }
  if (owner === "runtime") return { owner, path, localRuntime, batch, ...isolation, inputs: "inputs" in value ? inputFiles(value.inputs, file) : [] };
  if (owner !== "native-probe") {
    if ("inputs" in value) throw new Error(`Only runtime, native-probe and browser-guest checks declare input files: ${file}`);
    if (owner === "native") return { owner, path, localRuntime, batch, ...nativeSelection(value, profile, file), ...(entry === undefined ? {} : { entry }) };
    return { owner, path, localRuntime, batch, ...isolation };
  }
  const inputs = inputFiles("inputs" in value ? value.inputs : undefined, file);
  return { owner, path, localRuntime, batch, inputs };
}

export function discoverChecks(directory = root): Check[] {
  const manifests = join(directory, "checks");
  const files = readdirSync(manifests).sort();
  if (files.length === 0) throw new Error("Missing check manifests");
  const checks = files.map(file => {
    if (!/^[a-z0-9-]+\.json$/.test(file) || !lstatSync(join(manifests, file)).isFile()) throw new Error(`Unsafe manifest: ${file}`);
    const check = parseCheck(JSON.parse(readFileSync(join(manifests, file), "utf8")), file);
    const absolute = join(directory, check.path);
    if (realpathSync(absolute) !== join(realpathSync(directory), check.path)) throw new Error(`Unsafe linked check: ${check.path}`);
    const stat = lstatSync(absolute);
    if (check.owner === "native" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Missing check input: ${check.path}`);
    if (check.entry !== undefined) requireEntryFiles(absolute, check.entry, checkId(check));
    return check;
  });
  const ids = new Set<string>();
  const first = new Map<string, Check>();
  for (const check of checks) {
    const id = checkId(check);
    // The same id twice is one execution with two owners, and so are two defaults of one path.
    if (ids.has(id)) throw new Error(`Duplicate check owner: ${id}`);
    ids.add(id);
    // Only a native shared-group fixture has more than one command.
    const other = first.get(check.path);
    if (other && !(sharedNative(other) && sharedNative(check))) throw new Error(`Conflicting check owners: ${check.path}`);
    first.set(check.path, other ?? check);
  }
  return checks.sort((left, right) => compare(left.path, right.path) || compare(left.entry ?? "", right.entry ?? ""));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

/** An entry's command and expected output are regular files of the fixture, not links out of it. */
export function requireEntryFiles(fixture: string, entry: string | undefined, id: string): { command: string; expected: string } {
  const files = entryFiles(entry);
  for (const name of [files.command, files.expected]) {
    const stat = lstatSync(join(fixture, name), { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Missing or unsafe check entry file: ${id} needs ${name}`);
  }
  return files;
}

export function nativeProfile(value: unknown): NativeProfile {
  if (value === "split" || value === "shared-group") return value;
  throw new Error(`Invalid native profile: ${String(value)}`);
}

export function selectChecks(owner: string, checks: readonly Check[] = discoverChecks(), profile: NativeProfile = "split"): string[] {
  if (owner === "local-runtime") return checks.filter(check => check.localRuntime).map(check => check.path);
  const selected = parseOwner(owner);
  const ids = checks.filter(check => check.owner === selected && (check.owner === "native" || check.owner === "browser-guest" ? check.profile ?? "split" : profile) === profile).map(checkId);
  if (ids.length === 0) throw new Error(`Missing checks for ${owner}`);
  return ids;
}

/** `paths` are check ids: a path, or `path#entry` for a named command of a native shared-group fixture. */
export function namedCheckBatches(owner: string, checks: readonly Check[] = discoverChecks(), profile: NativeProfile = "split"): { name: string; paths: string[] }[] {
  const ids = new Set(selectChecks(owner, checks, profile));
  if (owner === "local-runtime") return [{ name: "default", paths: Array.from(ids) }];
  const batches = new Map<string, string[]>();
  for (const check of checks.filter(check => ids.has(checkId(check)))) batches.set(check.batch, (batches.get(check.batch) ?? []).concat([checkId(check)]));
  return Array.from(batches.keys()).sort().map(name => ({ name, paths: batches.get(name)! }));
}

export function checkBatches(owner: string, checks: readonly Check[] = discoverChecks(), profile: NativeProfile = "split"): string[][] {
  return namedCheckBatches(owner, checks, profile).map(batch => batch.paths);
}

export function selectCheckBatch(owner: string, name: string, checks: readonly Check[] = discoverChecks(), profile: NativeProfile = "split"): string[] {
  const batch = namedCheckBatches(owner, checks, profile).find(batch => batch.name === name);
  if (!batch) throw new Error(`Unknown check batch for ${owner}: ${name}`);
  return batch.paths;
}

export function automaticChecks(directory = root): { owner: string; path: string }[] {
  return ["tests/package", "web/tests"].flatMap(folder => readdirSync(join(directory, folder)).sort()
    .filter(file => folder === "tests/package" ? /\.test\.ts$/.test(file) : /\.test\.(?:js|ts)$/.test(file))
    .map(file => ({ owner: folder === "tests/package" ? "package" : "web", path: `${folder}/${file}` })));
}

function nativeEngineArguments(engine: NativeEngine | undefined, env: NodeJS.ProcessEnv): string[] {
  if (engine === undefined) return [];
  if (engine !== "spidermonkey") return ["--engine", engine];
  const core = env.SPIDERMONKEY_WASM;
  if (!core || !isAbsolute(core)) throw new Error("SpiderMonkey fixture checks require absolute SPIDERMONKEY_WASM");
  return ["--engine", engine, "--wasm", core, "--tier", "interp"];
}

export function checkCommand(owner: string, paths?: readonly string[], profile: NativeProfile = "split", engine?: NativeEngine, env = process.env): string[] {
  const selected = paths ?? selectChecks(owner, undefined, profile);
  if (owner === "native" && profile === "shared-group") return ["bun", join(root, "scripts/native-profile-fixtures.ts")].concat(selected);
  if (owner === "native") return ["bash", join(root, "scripts/test.sh"), "--no-build"].concat(nativeEngineArguments(engine, env), selected.map(path => path.slice("tests/fixtures/".length)));
  return ["bun", "test"].concat(selected.map(path => join(root, path)));
}

export function runCheck(command: readonly string[], env = process.env): number {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing check command");
  const child = spawnSync(executable, args, { stdio: "inherit", env });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`Check runner terminated by ${child.signal}`);
  return child.status ?? 1;
}

// Each test.sh run has its own scratch directory and test server, so fixture groups run side by side.
export function nativeGroups(paths: readonly string[], count: number): string[][] {
  const size = Math.max(1, Math.min(count, paths.length));
  const groups = Array.from({ length: size }, (): string[] => []);
  paths.forEach((path, index) => groups[index % size]!.push(path));
  return groups;
}

function nativeChunkCount(length: number, count: number): number {
  if (count <= 1) return 1;
  return Math.min(length, Math.max(count, Math.ceil(length / 16)));
}

export function nativeEngineGroups(paths: readonly string[], options: { count: number; checks?: readonly Check[]; producers?: readonly NativeEngine[]; env?: NodeJS.ProcessEnv; chunked?: boolean }) {
  const { count, checks = discoverChecks(), producers = nativeEngines, env = process.env, chunked = false } = options;
  const selected = new Set(paths);
  const native = checks.filter(check => check.owner === "native");
  return nativeEngines.flatMap(engine => {
    if (!producers.includes(engine)) return [];
    const selectedPaths = native.filter(check => check.profile !== "shared-group" && selected.has(check.path) && (check.engines ?? ["quickjs"]).includes(engine)).map(check => check.path);
    if (selectedPaths.length === 0) return [];
    const buckets = chunked ? nativeChunkCount(selectedPaths.length, count) : count;
    return [{ engine, commands: nativeGroups(selectedPaths, buckets).map(group => checkCommand("native", group, "split", engine, env)) }];
  });
}

function runBuffered(command: readonly string[], env: NodeJS.ProcessEnv): Promise<{ status: number; output: Buffer }> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing check command");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (signal) {
        chunks.push(Buffer.from(`\n[check runner terminated by ${signal}]\n`));
        resolvePromise({ status: 128 + (constants.signals[signal] ?? 1), output: Buffer.concat(chunks) });
        return;
      }
      resolvePromise({ status: status ?? 1, output: Buffer.concat(chunks) });
    });
  });
}

export function testJobs(value: string | undefined): number {
  if (value === undefined) return 1;
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new Error(`Invalid BUN_WASM_TEST_JOBS: ${value}`);
  return jobs;
}

const heavyTestFiles = [
  "scripts/ci-changes.test.ts",
  "scripts/ci-check-inputs.test.ts",
  "scripts/goals-matrix/playground.test.ts",
  "scripts/quality-probes.test.ts",
  "scripts/runtime-js-controls.test.ts",
  "scripts/goals-matrix/iphone-load.test.ts",
  "scripts/goals-matrix/iphone.test.ts",
  "scripts/spidermonkey-filenames.test.ts",
  "scripts/update-waffle-records.test.ts",
  "scripts/goals-matrix/deadlines.test.ts",
  "scripts/runtime-types.test.ts",
  "scripts/stack-measurement.test.ts",
  "scripts/c1/subreaper-isolation.test.ts",
];

export function shardTestFiles(paths: readonly string[], jobs: number): string[][] {
  if (jobs <= 1 || paths.length <= 1) return [paths.slice()];
  const heavyRank = new Map(heavyTestFiles.map((path, index) => [path, index]));
  const keyOf = (path: string) => isAbsolute(path) ? relative(root, path) : path;
  const heavy = paths
    .filter(path => heavyRank.has(keyOf(path)))
    .toSorted((a, b) => heavyRank.get(keyOf(a))! - heavyRank.get(keyOf(b))!);
  const rest = paths.filter(path => !heavyRank.has(keyOf(path)));
  const ordered = heavy.concat(rest);
  const count = Math.min(jobs, ordered.length);
  const shards = Array.from({ length: count }, (): string[] => []);
  ordered.forEach((path, index) => shards[index % count]!.push(path));
  return shards;
}

export async function runShardedFiles(files: readonly string[], jobs: number, env = process.env): Promise<number> {
  if (jobs <= 1 || files.length <= 1) return runCheck(["bun", "test"].concat(files), env);
  const shards = shardTestFiles(files, jobs);
  const results = await Promise.all(shards.map(shard => runBuffered(["bun", "test"].concat(shard), env)));
  for (const result of results) process.stdout.write(result.output);
  return results.find(result => result.status !== 0)?.status ?? 0;
}

async function runNative(paths: readonly string[], profile: NativeProfile): Promise<number> {
  if (profile === "shared-group") return runCheck(checkCommand("native", paths.slice(), profile));
  const count = Number(process.env.BUN_WASM_CHECK_JOBS ?? availableParallelism());
  if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid BUN_WASM_CHECK_JOBS: ${String(count)}`);
  const producers = nativeProducerEngines();
  const env = { ...process.env, BUN_WASM_CI_CHECKS: "1" };
  // Each test.sh would otherwise run the whole runtime suite again, in parallel.
  const runtime = runCheck(["bash", join(root, "scripts/check-runtime.sh")], env);
  if (runtime !== 0) return runtime;
  const grouped = { ...env, BUN_WASM_RUNTIME_CHECKED: "1" };
  const groups = nativeEngineGroups(paths, { count, producers, env: grouped, chunked: count > 1 });
  const tasks = groups.flatMap(group => group.commands.map(command => ({ engine: group.engine, command })));
  const outputs: ({ engine: NativeEngine; status: number; output: Buffer } | undefined)[] = Array.from({ length: tasks.length });
  let next = 0;
  let failure = 0;
  async function worker(): Promise<void> {
    while (failure === 0) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      const result = await runBuffered(task.command, grouped);
      outputs[index] = { engine: task.engine, ...result };
      if (result.status !== 0) failure ||= result.status;
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, tasks.length) }, () => worker()));
  let activeEngine: NativeEngine | undefined;
  for (const item of outputs) {
    if (!item) continue;
    if (item.engine !== activeEngine) {
      console.log(`Native fixture engine: ${item.engine}`);
      activeEngine = item.engine;
    }
    process.stdout.write(item.output);
  }
  return failure;
}

async function runOwner(owner: string, profile: NativeProfile, selectedBatch?: string): Promise<void> {
  if (owner === "runtime" && process.env.BUN_WASM_RUNTIME_JOBS !== undefined) {
    const { runtimeJobs, runRuntimeChecks } = await import("./runtime-file-checks.ts");
    const jobs = runtimeJobs(process.env.BUN_WASM_RUNTIME_JOBS);
    if (jobs > 1) {
      const paths = selectedBatch === undefined ? selectChecks(owner) : selectCheckBatch(owner, selectedBatch);
      process.exitCode = await runRuntimeChecks(paths, process.env, jobs);
      return;
    }
  }
  const shardable = owner === "quality" || owner === "web";
  const jobs = shardable ? testJobs(process.env.BUN_WASM_TEST_JOBS) : 1;
  const batches = selectedBatch === undefined ? checkBatches(owner, undefined, profile) : [selectCheckBatch(owner, selectedBatch, undefined, profile)];
  for (const batch of batches) {
    const status = owner === "native"
      ? await runNative(batch, profile)
      : shardable && jobs > 1
        ? await runShardedFiles(batch.map(path => join(root, path)), jobs, process.env)
        : runCheck(checkCommand(owner, batch), process.env);
    if (status === 0) continue;
    process.exitCode = status;
    return;
  }
}

export function checkArguments(args: readonly string[]) {
  const owner = args[0];
  if (!owner) throw new Error("Missing check owner");
  const options = args.slice(1);
  const at = options.indexOf("--profile");
  const profile = at < 0 ? "split" : nativeProfile(options[at + 1]);
  if (at >= 0 && !hasProfile(owner)) throw new Error("Only native and browser-guest checks select a profile");
  const remaining = at < 0 ? options : options.slice(0, at).concat(options.slice(at + 2));
  const batchAt = remaining.indexOf("--batch");
  const batch = batchAt < 0 ? undefined : remaining[batchAt + 1];
  if (batchAt >= 0 && (!batch || batch.startsWith("--"))) throw new Error("Missing check batch");
  const rest = batchAt < 0 ? remaining : remaining.slice(0, batchAt).concat(remaining.slice(batchAt + 2));
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--list" && rest[0] !== "--batches")) throw new Error("Unexpected check arguments");
  if (batch !== undefined && rest[0] === "--batches") throw new Error("Cannot list batches while selecting one");
  return { owner, profile, batch, list: rest[0] === "--list", batches: rest[0] === "--batches" };
}

if (import.meta.main) {
  const { owner, profile, batch, list, batches } = checkArguments(process.argv.slice(2));
  if (batches) console.log(JSON.stringify(namedCheckBatches(owner, undefined, profile).map(batch => batch.name)));
  else if (list) console.log((batch === undefined ? selectChecks(owner, undefined, profile) : selectCheckBatch(owner, batch, undefined, profile)).join("\n"));
  else await runOwner(owner, profile, batch);
}
