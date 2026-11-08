import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const owners = ["runtime", "web", "quality", "package-extra", "cmake", "web-browser", "browser-guest", "native", "native-probe"] as const;
type Owner = typeof owners[number];
export type NativeProfile = "split" | "shared-group";
type Check = { path: string; localRuntime: boolean; batch: string } & (
  | { owner: "native-probe"; inputs: string[] }
  | { owner: "native"; profile?: "shared-group"; inputs?: never }
  | { owner: Exclude<Owner, "native-probe" | "native">; inputs?: never; profile?: never }
);
const root = resolve(import.meta.dir, "..");

function parseOwner(value: unknown): Owner {
  for (const owner of owners) if (value === owner) return owner;
  throw new Error(`Unknown check owner: ${String(value)}`);
}

export function parseCheck(value: unknown, file: string): Check {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid check: ${file}`);
  if (!("owner" in value) || !("path" in value)) throw new Error(`Missing check fields: ${file}`);
  if (Object.keys(value).some(key => !["owner", "path", "localRuntime", "batch", "inputs", "profile"].includes(key))) throw new Error(`Unknown check fields: ${file}`);
  const owner = parseOwner(value.owner);
  if ("profile" in value && owner !== "native") throw new Error(`Only native checks select a profile: ${file}`);
  const profile = "profile" in value ? nativeProfile(value.profile) : "split";
  if (!file.startsWith(`${owner}-`)) throw new Error(`Owner must match manifest prefix: ${file}`);
  const path = value.path;
  const pattern = owner === "native" ? /^tests\/fixtures\/[a-z0-9][a-z0-9-]*$/ : /^scripts\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/;
  if (typeof path !== "string" || !pattern.test(path)) throw new Error(`Unsafe check path: ${file}`);
  const localRuntime = "localRuntime" in value ? value.localRuntime : false;
  if (typeof localRuntime !== "boolean" || (localRuntime && owner !== "runtime" && owner !== "web")) throw new Error(`Invalid local runtime selection: ${file}`);
  const batch = "batch" in value ? value.batch : "default";
  if (typeof batch !== "string" || (batch !== "default" && (owner !== "web" || !/^[0-9]{2}-[a-z0-9-]+$/.test(batch)))) throw new Error(`Invalid check batch: ${file}`);
  if (owner !== "native-probe") {
    if ("inputs" in value) throw new Error(`Only native-probe checks declare input files: ${file}`);
    if (owner === "native" && profile === "shared-group") return { owner, path, localRuntime, batch, profile };
    return { owner, path, localRuntime, batch };
  }
  const inputs = "inputs" in value ? value.inputs : undefined;
  if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every(input => typeof input === "string" && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(input) && !input.split("/").includes(".."))) throw new Error(`Invalid native-probe input files: ${file}`);
  if (new Set(inputs).size !== inputs.length) throw new Error(`Duplicate native-probe inputs: ${file}`);
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
  const paths = checks.filter(check => check.owner === selected && (check.owner !== "native" || (check.profile ?? "split") === profile)).map(check => check.path);
  if (paths.length === 0) throw new Error(`Missing checks for ${owner}`);
  return paths;
}

export function checkBatches(owner: string, checks: readonly Check[] = discoverChecks(), profile: NativeProfile = "split"): string[][] {
  const paths = new Set(selectChecks(owner, checks, profile));
  if (owner === "local-runtime") return [Array.from(paths)];
  const batches = new Map<string, string[]>();
  for (const check of checks.filter(check => paths.has(check.path))) batches.set(check.batch, (batches.get(check.batch) ?? []).concat([check.path]));
  return Array.from(batches.keys()).sort().map(batch => batches.get(batch)!);
}

export function automaticChecks(directory = root): { owner: string; path: string }[] {
  return ["tests/package", "web/tests"].flatMap(folder => readdirSync(join(directory, folder)).sort()
    .filter(file => folder === "tests/package" ? /\.test\.ts$/.test(file) : /\.test\.(?:js|ts)$/.test(file))
    .map(file => ({ owner: folder === "tests/package" ? "package" : "web", path: `${folder}/${file}` })));
}

export function checkCommand(owner: string, paths?: readonly string[], profile: NativeProfile = "split"): string[] {
  const selected = paths ?? selectChecks(owner, undefined, profile);
  if (owner === "native" && profile === "shared-group") return ["bun", join(root, "scripts/native-profile-fixtures.ts")].concat(selected);
  if (owner === "native") return ["bash", join(root, "scripts/test.sh"), "--no-build"].concat(selected.map(path => path.slice("tests/fixtures/".length)));
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
  const env = { ...process.env, BUN_WASM_CI_CHECKS: "1" };
  // Each test.sh would otherwise run the whole runtime suite again, in parallel.
  const runtime = runCheck(["bash", join(root, "scripts/check-runtime.sh")], env);
  if (runtime !== 0) return runtime;
  const grouped = { ...env, BUN_WASM_RUNTIME_CHECKED: "1" };
  const results = await Promise.all(nativeGroups(paths, count).map(group => runBuffered(checkCommand("native", group), grouped)));
  for (const result of results) process.stdout.write(result.output);
  return results.find(result => result.status !== 0)?.status ?? 0;
}

async function runOwner(owner: string, profile: NativeProfile): Promise<void> {
  for (const batch of checkBatches(owner, undefined, profile)) {
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
  if (at >= 0 && owner !== "native") throw new Error("Only native checks select a profile");
  const rest = at < 0 ? options : options.slice(0, at).concat(options.slice(at + 2));
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--list")) throw new Error("Unexpected check arguments");
  return { owner, profile, list: rest.length === 1 };
}

if (import.meta.main) {
  const { owner, profile, list } = checkArguments(process.argv.slice(2));
  if (list) console.log(selectChecks(owner, undefined, profile).join("\n"));
  else await runOwner(owner, profile);
}
