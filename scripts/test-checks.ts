import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const owners = ["runtime", "web", "quality", "package-extra", "cmake", "web-browser", "browser-guest", "native", "native-probe"] as const;
type Owner = typeof owners[number];
export type NativeProfile = "split" | "shared-group";
const nativeEngines = ["quickjs", "jsc", "browser", "spidermonkey"] as const;
export type NativeEngine = typeof nativeEngines[number];
type NativeSelection = { profile: "shared-group"; engines?: never } | { profile?: never; engines?: readonly NativeEngine[] };
type Check = { path: string; localRuntime: boolean; batch: string } & (
  | { owner: "native-probe"; inputs: string[] }
  | ({ owner: "native"; inputs?: never } & NativeSelection)
  | { owner: "browser-guest"; profile?: "shared-group"; inputs: string[] }
  | { owner: Exclude<Owner, "native-probe" | "native" | "browser-guest">; inputs?: never; profile?: never }
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
  return env.INSTALL_ENGINES === undefined ? nativeEngines : engineSubset(env.INSTALL_ENGINES.split(","), "INSTALL_ENGINES");
}

export function parseCheck(value: unknown, file: string): Check {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid check: ${file}`);
  if (!("owner" in value) || !("path" in value)) throw new Error(`Missing check fields: ${file}`);
  if (Object.keys(value).some(key => !["owner", "path", "localRuntime", "batch", "inputs", "profile", "engines"].includes(key))) throw new Error(`Unknown check fields: ${file}`);
  const owner = parseOwner(value.owner);
  if ("engines" in value && owner !== "native") throw new Error(`Only split native checks select engines: ${file}`);
  if ("profile" in value && !hasProfile(owner)) throw new Error(`Only native and browser-guest checks select a profile: ${file}`);
  const profile = "profile" in value ? nativeProfile(value.profile) : "split";
  if (!file.startsWith(`${owner}-`)) throw new Error(`Owner must match manifest prefix: ${file}`);
  const path = value.path;
  const pattern = owner === "native" ? /^tests\/fixtures\/[a-z0-9][a-z0-9-]*$/ : /^scripts\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/;
  if (typeof path !== "string" || !pattern.test(path)) throw new Error(`Unsafe check path: ${file}`);
  const localRuntime = "localRuntime" in value ? value.localRuntime : false;
  if (typeof localRuntime !== "boolean" || (localRuntime && owner !== "runtime" && owner !== "web")) throw new Error(`Invalid local runtime selection: ${file}`);
  const batch = "batch" in value ? value.batch : "default";
  if (typeof batch !== "string" || (batch !== "default" && ((owner !== "web" && owner !== "browser-guest" && owner !== "web-browser") || !/^[0-9]{2}-[a-z0-9-]+$/.test(batch)))) throw new Error(`Invalid check batch: ${file}`);
  if (owner === "browser-guest") {
    const inputs = "inputs" in value ? inputFiles(value.inputs, file) : [];
    if (profile === "shared-group") return { owner, path, localRuntime, batch, profile, inputs };
    return { owner, path, localRuntime, batch, inputs };
  }
  if (owner !== "native-probe") {
    if ("inputs" in value) throw new Error(`Only native-probe and browser-guest checks declare input files: ${file}`);
    if (owner === "native") return { owner, path, localRuntime, batch, ...nativeSelection(value, profile, file) };
    return { owner, path, localRuntime, batch };
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
    return check;
  });
  const paths = new Set<string>();
  for (const check of checks) {
    if (paths.has(check.path)) throw new Error(`Duplicate check owner: ${check.path}`);
    paths.add(check.path);
  }
  return checks.sort((left, right) => left.path < right.path ? -1 : Number(left.path > right.path));
}

export function nativeProfile(value: unknown): NativeProfile {
  if (value === "split" || value === "shared-group") return value;
  throw new Error(`Invalid native profile: ${String(value)}`);
}

export function selectChecks(owner: string, checks: readonly Check[] = discoverChecks(), profile: NativeProfile = "split"): string[] {
  if (owner === "local-runtime") return checks.filter(check => check.localRuntime).map(check => check.path);
  const selected = parseOwner(owner);
  const paths = checks.filter(check => check.owner === selected && (check.owner === "native" || check.owner === "browser-guest" ? check.profile ?? "split" : profile) === profile).map(check => check.path);
  if (paths.length === 0) throw new Error(`Missing checks for ${owner}`);
  return paths;
}

export function namedCheckBatches(owner: string, checks: readonly Check[] = discoverChecks(), profile: NativeProfile = "split"): { name: string; paths: string[] }[] {
  const paths = new Set(selectChecks(owner, checks, profile));
  if (owner === "local-runtime") return [{ name: "default", paths: Array.from(paths) }];
  const batches = new Map<string, string[]>();
  for (const check of checks.filter(check => paths.has(check.path))) batches.set(check.batch, (batches.get(check.batch) ?? []).concat([check.path]));
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

export function nativeEngineGroups(paths: readonly string[], options: { count: number; checks?: readonly Check[]; producers?: readonly NativeEngine[]; env?: NodeJS.ProcessEnv }) {
  const { count, checks = discoverChecks(), producers = nativeEngines, env = process.env } = options;
  const selected = new Set(paths);
  const native = checks.filter(check => check.owner === "native");
  return nativeEngines.flatMap(engine => {
    if (!producers.includes(engine)) return [];
    const selectedPaths = native.filter(check => check.profile !== "shared-group" && selected.has(check.path) && (check.engines ?? ["quickjs"]).includes(engine)).map(check => check.path);
    if (selectedPaths.length === 0) return [];
    return [{ engine, commands: nativeGroups(selectedPaths, count).map(group => checkCommand("native", group, "split", engine, env)) }];
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
      if (signal) reject(new Error(`Check runner terminated by ${signal}`));
      else resolvePromise({ status: status ?? 1, output: Buffer.concat(chunks) });
    });
  });
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
  for (const group of nativeEngineGroups(paths, { count, producers, env: grouped })) {
    console.log(`Native fixture engine: ${group.engine}`);
    const results = await Promise.all(group.commands.map(command => runBuffered(command, grouped)));
    for (const result of results) process.stdout.write(result.output);
    const failure = results.find(result => result.status !== 0);
    if (failure) return failure.status;
  }
  return 0;
}

async function runOwner(owner: string, profile: NativeProfile, selectedBatch?: string): Promise<void> {
  const batches = selectedBatch === undefined ? checkBatches(owner, undefined, profile) : [selectCheckBatch(owner, selectedBatch, undefined, profile)];
  for (const batch of batches) {
    const status = owner === "native" ? await runNative(batch, profile) : runCheck(checkCommand(owner, batch), process.env);
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
