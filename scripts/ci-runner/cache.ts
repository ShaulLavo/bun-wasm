import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { digest } from "./host.ts";

type CacheConfig = {
  root: string;
  workspace: string;
  temporary: string;
  key: string;
  prefixes: string[];
  patterns: string[];
  output: string;
  maxBytes: number;
};
type Snapshot = { key: string; patterns: string[]; created: number; sha256: string };
const maximumBytes = 32 * 1024 ** 3;
const maximumEntries = 256;

function lines(value: string | undefined): string[] {
  return value?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [];
}

function input(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`Missing ${variable}`);
  return value;
}

function contained(path: string, parent: string): boolean {
  const tail = relative(parent, path);
  return tail === "" || (!tail.startsWith("../") && tail !== ".." && !tail.startsWith("/"));
}

function privatePath(path: string): string {
  const absolute = resolve(path);
  if (!isAbsolute(path) || absolute === "/") throw new Error("Cache paths must be absolute private directories");
  return absolute;
}

function configuration(): CacheConfig {
  const root = privatePath(input("BUN_WASM_PC_CACHE_ROOT"));
  const workspace = privatePath(input("GITHUB_WORKSPACE"));
  const temporary = privatePath(input("RUNNER_TEMP"));
  if ([workspace, temporary].some(path => contained(root, path) || contained(path, root))) throw new Error("Cache storage must be separate from job paths");
  const maxBytes = Number(process.env.BUN_WASM_PC_CACHE_MAX_BYTES ?? maximumBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumBytes) throw new Error("Invalid cache retention budget");
  const key = input("CACHE_KEY");
  if (key.length > 512 || Array.from(key).some(character => character.charCodeAt(0) < 32)) throw new Error("Invalid cache key");
  const patterns = lines(input("CACHE_PATHS"));
  if (patterns.length === 0) throw new Error("Missing cache paths");
  return { root, workspace, temporary, key, patterns, prefixes: lines(process.env.CACHE_RESTORE_KEYS), output: input("GITHUB_OUTPUT"), maxBytes };
}

function snapshotDirectories(directory: string): string[] {
  return readdirSync(directory).filter(entry => /^[a-f0-9]{64}$/.test(entry)).map(entry => `${directory}/${entry}`);
}

function snapshotBytes(directory: string): number {
  return statSync(`${directory}/snapshot.tar.zst`).size + statSync(`${directory}/snapshot.json`).size;
}

function prune(directory: string, maxBytes: number, reserveBytes = 0, reserveEntries = 0): void {
  const entries = snapshotDirectories(directory).map(path => ({ path, bytes: snapshotBytes(path), used: statSync(path).mtimeMs }));
  entries.sort((a, b) => a.used - b.used || a.path.localeCompare(b.path));
  let bytes = entries.reduce((total, entry) => total + entry.bytes, reserveBytes);
  let count = entries.length + reserveEntries;
  for (const entry of entries) {
    if (bytes <= maxBytes && count <= maximumEntries) break;
    rmSync(entry.path, { recursive: true });
    bytes -= entry.bytes;
    count -= 1;
  }
}

function patternPath(pattern: string, config: CacheConfig): string {
  const expanded = pattern.startsWith("~/") ? `${input("HOME")}/${pattern.slice(2)}` : pattern;
  const absolute = resolve(config.workspace, expanded);
  if (!contained(absolute, config.workspace) && !contained(absolute, config.temporary)) throw new Error("Cache input is outside job workspace and temporary directory");
  if (contained(absolute, config.root) || absolute === config.workspace || absolute === config.temporary) throw new Error("Refusing cache root or whole-job snapshot");
  return absolute;
}

function signature(patterns: string[]): string {
  return createHash("sha256").update(JSON.stringify(patterns)).digest("hex");
}

function parseSnapshot(value: unknown): Snapshot {
  if (typeof value !== "object" || value === null || !("key" in value) || !("patterns" in value) || !("created" in value) || !("sha256" in value)) throw new Error("Invalid cache metadata");
  if (typeof value.key !== "string" || !Array.isArray(value.patterns) || !value.patterns.every(item => typeof item === "string")) throw new Error("Invalid cache metadata");
  if (typeof value.created !== "number" || !Number.isFinite(value.created) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Invalid cache metadata");
  return { key: value.key, patterns: value.patterns, created: value.created, sha256: value.sha256 };
}

function output(config: CacheConfig, hit: boolean, matched: string): void {
  if (/[\r\n]/.test(matched)) throw new Error("Invalid matched key");
  appendFileSync(config.output, `cache-hit=${hit}\ncache-matched-key=${matched}\n`);
  process.stdout.write(`${JSON.stringify({ event: "pc-cache-restore", key: config.key, matchedKey: matched, exact: hit })}\n`);
}

function tar(args: string[]): void {
  const result = spawnSync("tar", args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 1_800_000 });
  if (result.status !== 0) throw new Error(`Cache archive operation failed with status ${result.status}`);
}

function selectSnapshot(config: CacheConfig, directory: string): { directory: string; snapshot: Snapshot } | undefined {
  const candidates = snapshotDirectories(directory).map(path => {
    const snapshot = parseSnapshot(JSON.parse(readFileSync(`${path}/snapshot.json`, "utf8")));
    return { directory: path, snapshot };
  }).filter(entry => signature(entry.snapshot.patterns) === signature(config.patterns));
  candidates.sort((a, b) => b.snapshot.created - a.snapshot.created);
  const exact = candidates.find(entry => entry.snapshot.key === config.key);
  if (exact) return exact;
  for (const prefix of config.prefixes) {
    const match = candidates.find(entry => entry.snapshot.key.startsWith(prefix));
    if (match) return match;
  }
  return undefined;
}

async function restore(config: CacheConfig, directory: string): Promise<void> {
  config.patterns.forEach(pattern => patternPath(pattern.replace(/^!/, ""), config));
  const match = selectSnapshot(config, directory);
  if (!match) return output(config, false, "");
  const archive = `${match.directory}/snapshot.tar.zst`;
  if (await digest(archive) !== match.snapshot.sha256) throw new Error("Corrupt cache archive");
  tar(["--extract", "--zstd", "--file", archive, "--directory", "/", "--no-same-owner", "--delay-directory-restore"]);
  const now = new Date();
  utimesSync(match.directory, now, now);
  output(config, match.snapshot.key === config.key, match.snapshot.key);
}

function matches(config: CacheConfig): string[] {
  const excludes = config.patterns.filter(pattern => pattern.startsWith("!")).map(pattern => patternPath(pattern.slice(1), config));
  const includes = config.patterns.filter(pattern => !pattern.startsWith("!")).map(pattern => patternPath(pattern, config));
  const paths = globSync(includes, { exclude: excludes }).map(path => resolve(path));
  paths.sort();
  const roots: string[] = [];
  for (const path of paths) {
    const previous = roots.at(-1);
    if (!previous || !contained(path, previous)) roots.push(path);
  }
  return roots;
}

async function save(config: CacheConfig, directory: string): Promise<void> {
  if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_REPOSITORY !== "ShaulLavo/bun-wasm") throw new Error("Only bun-wasm main pushes publish PC caches");
  const destination = `${directory}/${signature([config.key].concat(config.patterns))}`;
  if (existsSync(destination)) return;
  const paths = matches(config);
  if (paths.length === 0) return;
  for (const path of paths) {
    const actualParent = realpathSync(dirname(path));
    if (!contained(actualParent, config.workspace) && !contained(actualParent, config.temporary)) throw new Error("Cache input parent escapes job paths");
  }
  const stage = mkdtempSync(`${directory}/.saving-`);
  try {
    writeFileSync(`${stage}/files`, paths.map(path => path.slice(1)).join("\0") + "\0");
    const excludes = config.patterns.filter(pattern => pattern.startsWith("!")).map(pattern => `--exclude=${patternPath(pattern.slice(1), config).slice(1)}`);
    tar(["--create", "--format=posix", "--pax-option=delete=atime,delete=ctime", "--zstd", "--file", `${stage}/snapshot.tar.zst`, "--directory", "/"].concat(excludes, ["--null", "--verbatim-files-from", "--files-from", `${stage}/files`]));
    const snapshot: Snapshot = { key: config.key, patterns: config.patterns, created: Date.now(), sha256: await digest(`${stage}/snapshot.tar.zst`) };
    writeFileSync(`${stage}/snapshot.json`, JSON.stringify(snapshot));
    rmSync(`${stage}/files`);
    const bytes = snapshotBytes(stage);
    if (bytes > config.maxBytes) return;
    prune(directory, config.maxBytes, bytes, 1);
    if (!existsSync(destination)) renameSync(stage, destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const config = configuration();
  const directory = `${config.root}/snapshots-v1`;
  mkdirSync(directory, { recursive: true });
  if (realpathSync(directory) !== directory) throw new Error("Cache storage must use its physical private path");
  if (process.argv[2] !== "--locked") {
    const result = spawnSync("flock", ["--exclusive", "--timeout", "1800", `${config.root}/snapshot.lock`, process.execPath, new URL(import.meta.url).pathname, "--locked"].concat(process.argv.slice(2)), { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Cache lock or operation failed with status ${result.status}`);
    return;
  }
  for (const entry of readdirSync(directory).filter(name => /^\.saving-[a-zA-Z0-9]+$/.test(name))) rmSync(`${directory}/${entry}`, { recursive: true, force: true });
  prune(directory, config.maxBytes);
  if (process.argv[3] === "restore") return restore(config, directory);
  if (process.argv[3] === "save") return save(config, directory);
  throw new Error("Expected restore or save");
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "PC cache failed"}\n`); process.exitCode = 1; });
}
