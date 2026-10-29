import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const owners = ["runtime", "web", "quality", "package-extra", "cmake", "web-browser", "native"] as const;
type Owner = typeof owners[number];
type Check = { owner: Owner; path: string; localRuntime: boolean; batch: string };
const root = resolve(import.meta.dir, "..");

function parseOwner(value: unknown): Owner {
  for (const owner of owners) if (value === owner) return owner;
  throw new Error(`Unknown check owner: ${String(value)}`);
}

export function parseCheck(value: unknown, file: string): Check {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid check: ${file}`);
  if (!("owner" in value) || !("path" in value)) throw new Error(`Missing check fields: ${file}`);
  if (Object.keys(value).some(key => !["owner", "path", "localRuntime", "batch"].includes(key))) throw new Error(`Unknown check fields: ${file}`);
  const owner = parseOwner(value.owner);
  if (!file.startsWith(`${owner}-`)) throw new Error(`Owner must match manifest prefix: ${file}`);
  const path = value.path;
  const pattern = owner === "native" ? /^tests\/fixtures\/[a-z0-9][a-z0-9-]*$/ : /^scripts\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/;
  if (typeof path !== "string" || !pattern.test(path)) throw new Error(`Unsafe check path: ${file}`);
  const localRuntime = "localRuntime" in value ? value.localRuntime : false;
  if (typeof localRuntime !== "boolean" || (localRuntime && owner !== "runtime" && owner !== "web")) throw new Error(`Invalid local runtime selection: ${file}`);
  const batch = "batch" in value ? value.batch : "default";
  if (typeof batch !== "string" || (batch !== "default" && (owner !== "web" || !/^[0-9]{2}-[a-z0-9-]+$/.test(batch)))) throw new Error(`Invalid check batch: ${file}`);
  return { owner, path, localRuntime, batch };
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

export function selectChecks(owner: string, checks: readonly Check[] = discoverChecks()): string[] {
  if (owner === "local-runtime") return checks.filter(check => check.localRuntime).map(check => check.path);
  const selected = parseOwner(owner);
  const paths = checks.filter(check => check.owner === selected).map(check => check.path);
  if (paths.length === 0) throw new Error(`Missing checks for ${owner}`);
  return paths;
}

export function checkBatches(owner: string, checks: readonly Check[] = discoverChecks()): string[][] {
  const paths = new Set(selectChecks(owner, checks));
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

export function checkCommand(owner: string, paths = selectChecks(owner)): string[] {
  if (owner === "native") return ["bash", join(root, "scripts/test.sh"), "--no-build"].concat(paths.map(path => path.slice("tests/fixtures/".length)));
  return ["bun", "test"].concat(paths.map(path => join(root, path)));
}

export function runCheck(command: readonly string[], env = process.env): number {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing check command");
  const child = spawnSync(executable, args, { stdio: "inherit", env });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`Check runner terminated by ${child.signal}`);
  return child.status ?? 1;
}

function runOwner(owner: string): void {
  for (const batch of checkBatches(owner)) {
    const status = runCheck(checkCommand(owner, batch), owner === "native" ? { ...process.env, BUN_WASM_CI_CHECKS: "1" } : process.env);
    if (status === 0) continue;
    process.exitCode = status;
    return;
  }
}

if (import.meta.main) {
  const [owner, mode] = process.argv.slice(2);
  if (!owner || (mode !== undefined && mode !== "--list")) throw new Error("Usage: test-checks.ts <owner|local-runtime> [--list]");
  if (mode === "--list") console.log(selectChecks(owner).join("\n"));
  else runOwner(owner);
}
