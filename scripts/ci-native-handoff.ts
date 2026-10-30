import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

const archiveNames = ["target.tar.zst", "cargo.tar.zst", "sources.tar.zst"] as const;
type ArchiveName = typeof archiveNames[number];
type GitDirectory = { archive: ArchiveName; path: string; bare: boolean };
type Context = ReturnType<typeof context>;

function required(name: string): string {
  const value = process.env[name];
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`Missing or unsafe ${name}`);
  return value;
}
function digestText(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Expected SHA-256 digest");
  return value;
}
function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory].concat(args), { encoding: "utf8" }).trim();
}
function context() {
  const workspace = realpathSync(required("GITHUB_WORKSPACE"));
  if (git(workspace, "status", "--porcelain", "--untracked-files=no")) throw new Error("Checkout tracked source differs from HEAD");
  const cargo = resolve(required("CARGO_HOME"));
  const target = resolve(required("CARGO_TARGET_DIR"));
  const attempt = required("NATIVE_QUALITY_PRODUCER_ATTEMPT");
  if (!/^[1-9][0-9]*$/.test(attempt)) throw new Error("Invalid producer attempt");
  const sha = required("GITHUB_SHA");
  if (!/^[a-f0-9]{40}$/.test(sha) || git(workspace, "rev-parse", "HEAD") !== sha) throw new Error("Checkout is not the workflow source");
  if (target !== join(workspace, "target") || cargo !== join(required("RUNNER_TEMP"), "cargo")) throw new Error("Unexpected native state paths");
  return {
    workspace, cargo, target,
    identity: {
      run: required("GITHUB_RUN_ID"), attempt, sha, tree: git(workspace, "rev-parse", "HEAD^{tree}"), workspace, cargo, target,
      host: digestText(required("NATIVE_HOST_TOOLS_HASH")), native: digestText(required("NATIVE_INPUTS_HASH")),
      sysroot: digestText(required("NATIVE_SYSROOT_SHA256")), prebuild: digestText(required("JSC_PREBUILD_MANIFEST_SHA256")),
    },
  };
}
function layout(state: Context) {
  return [
    { name: archiveNames[0], directory: state.target, roots: ["."] },
    { name: archiveNames[1], directory: state.cargo, roots: ["registry", "git", "bin/cargo-machete"] },
    { name: archiveNames[2], directory: state.workspace, roots: ["vendor/bun", "vendor/boringssl"] },
  ];
}
function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || path.split("/").includes("..") || /[\r\n\0]/.test(path)) throw new Error(`Unsafe archive path: ${path}`);
  return path;
}
function metadataRoot(path: string): { root: string; rest: string } | undefined {
  const match = /^(.*(?:^|\/)\.git)(?:\/(.*))?$/.exec(path) ?? /^(git\/db\/[^/]+)(?:\/(.*))?$/.exec(path);
  return match ? { root: match[1]!, rest: match[2] ?? "" } : undefined;
}
function include(path: string, tracked: ReadonlySet<string>): boolean {
  if (path.split("/").includes("node_modules") && !tracked.has(path)) return false;
  const metadata = metadataRoot(path);
  if (!metadata || !metadata.rest) return true;
  if (metadata.rest === "objects/info/alternates") throw new Error("External Git object alternates are not supported");
  return /^(?:HEAD|index|shallow|packed-refs)$/.test(metadata.rest) || /^(?:objects|refs)(?:\/|$)/.test(metadata.rest);
}
function ancestors(paths: Set<string>, path: string): void {
  let prefix = "";
  for (const part of safeRelative(path).split("/")) {
    prefix = prefix ? `${prefix}/${part}` : part;
    paths.add(prefix);
  }
}
function trackDependencies(directory: string, path: string, tracked: Set<string>): void {
  let metadata;
  try { metadata = lstatSync(join(directory, ".git")); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  if (metadata.isSymbolicLink()) throw new Error("Git metadata must not follow external links");
  if (!metadata.isDirectory()) throw new Error("Git metadata must be a private directory");
  const files = execFileSync("git", ["-C", directory, "ls-files", "-z", "--", ":(glob)**/node_modules", ":(glob)**/node_modules/**"], { encoding: "utf8" });
  for (const file of files.split("\0")) {
    if (!file.split("/").includes("node_modules")) continue;
    ancestors(tracked, path === "." ? file : `${path}/${file}`);
  }
}
function inventory(directory: string, roots: string[], archive: ArchiveName, repositories: GitDirectory[]): string[] {
  const paths: string[] = [];
  const tracked = new Set<string>();
  function visit(path: string): void {
    safeRelative(path);
    if (!include(path, tracked)) return;
    const absolute = join(directory, path);
    const stat = lstatSync(absolute);
    const metadata = metadataRoot(path);
    if (metadata && stat.isSymbolicLink()) throw new Error("Git metadata must not follow external links");
    if (metadata?.rest === "" && !stat.isDirectory()) throw new Error("Git metadata must be a private directory");
    if (metadata?.rest === "") repositories.push({ archive, path, bare: !path.endsWith(".git") });
    paths.push(path);
    if (!stat.isDirectory()) return;
    trackDependencies(absolute, path, tracked);
    for (const entry of readdirSync(absolute)) visit(path === "." ? entry : `${path}/${entry}`);
  }
  for (const root of roots) visit(root);
  return paths;
}
async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
function shell(script: string, ...args: string[]): void {
  execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script, "native-handoff"].concat(args), { stdio: "inherit" });
}
function output(values: Record<string, string>): void {
  appendFileSync(required("GITHUB_OUTPUT"), Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
}
async function pack(state: Context, bundle: string): Promise<void> {
  if (existsSync(bundle)) throw new Error("Refusing an existing handoff bundle");
  mkdirSync(bundle);
  const scratch = mkdtempSync(join(required("RUNNER_TEMP"), "native-quality-pack-"));
  try { await packArchives(state, bundle, scratch); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
async function packArchives(state: Context, bundle: string, scratch: string): Promise<void> {
  const repositories: GitDirectory[] = [];
  const archives: Record<string, string> = {};
  mkdirSync(join(state.cargo, "git"), { recursive: true });
  for (const item of layout(state)) {
    const start = performance.now();
    const paths = inventory(item.directory, item.roots, item.name, repositories);
    const list = join(scratch, "files");
    writeFileSync(list, paths.join("\0") + "\0");
    shell('tar --posix --no-recursion --null -C "$1" -T "$2" -cpf - | zstd -T2 -o "$3"', item.directory, list, join(bundle, item.name));
    archives[item.name] = await hash(join(bundle, item.name));
    console.log(JSON.stringify({ archive: item.name, bytes: statSync(join(bundle, item.name)).size, packMs: Math.round(performance.now() - start) }));
  }
  const bun = { head: git(join(state.workspace, "vendor/bun"), "rev-parse", "HEAD"), tree: git(join(state.workspace, "vendor/bun"), "rev-parse", "HEAD^{tree}") };
  const manifest = { schema: 1, identity: state.identity, archives, repositories, bun };
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest));
  output({ "manifest-sha256": await hash(join(bundle, "manifest.json")), "producer-attempt": state.identity.attempt });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native handoff object");
  return Object.fromEntries(Object.entries(value));
}
function parseGit(value: unknown): GitDirectory {
  const item = object(value);
  const name = archiveNames.find(name => name === item.archive);
  if (!name || typeof item.path !== "string" || typeof item.bare !== "boolean") throw new Error("Invalid Git directory");
  const path = safeRelative(item.path);
  const metadata = metadataRoot(path);
  if (!metadata || metadata.rest || item.bare !== !path.endsWith(".git")) throw new Error("Invalid Git metadata root");
  return { archive: name, path, bare: item.bare };
}
function absent(path: string): void {
  try { lstatSync(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  throw new Error(`Refusing to overlay native state: ${path}`);
}
function preflightDestinations(state: Context): void {
  for (const path of [state.target, join(state.cargo, "registry"), join(state.cargo, "git"), join(state.cargo, "bin/cargo-machete"), join(state.workspace, "vendor/bun"), join(state.workspace, "vendor/boringssl")]) absent(path);
}
async function inspect(state: Context, bundle: string) {
  digestText(required("NATIVE_QUALITY_MANIFEST_SHA256"));
  if (await hash(join(bundle, "manifest.json")) !== process.env.NATIVE_QUALITY_MANIFEST_SHA256) throw new Error("Native manifest digest mismatch");
  const manifest = object(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")));
  if (manifest.schema !== 1 || JSON.stringify(manifest.identity) !== JSON.stringify(state.identity)) throw new Error("Foreign native handoff identity");
  const archives = object(manifest.archives);
  if (JSON.stringify(Object.keys(archives)) !== JSON.stringify(archiveNames)) throw new Error("Native archive whitelist mismatch");
  if (JSON.stringify(readdirSync(bundle).sort()) !== JSON.stringify(["manifest.json"].concat(archiveNames).sort())) throw new Error("Unexpected native bundle files");
  for (const name of archiveNames) if (archives[name] !== await hash(join(bundle, name))) throw new Error(`Native archive digest mismatch: ${name}`);
  if (!Array.isArray(manifest.repositories)) throw new Error("Missing Git metadata inventory");
  const repositories = manifest.repositories.map(parseGit);
  preflightDestinations(state);
  return { repositories, bun: object(manifest.bun) };
}
function restoreGit(directory: string, repository: GitDirectory): void {
  const path = join(directory, repository.path);
  absent(join(path, "config"));
  writeFileSync(join(path, "config"), `[core]\nrepositoryformatversion = 0\nbare = ${repository.bare}\nfilemode = true\nlogallrefupdates = false\n`);
}
async function unpack(state: Context, bundle: string): Promise<void> {
  const start = performance.now();
  const manifest = await inspect(state, bundle);
  for (const item of layout(state)) {
    mkdirSync(item.directory, { recursive: true });
    shell('zstd -dc "$1" | tar --no-same-owner -xpf - -C "$2"', join(bundle, item.name), item.directory);
    for (const repository of manifest.repositories.filter(repository => repository.archive === item.name)) restoreGit(item.directory, repository);
  }
  const bun = join(state.workspace, "vendor/bun");
  if (git(bun, "rev-parse", "HEAD") !== manifest.bun.head || git(bun, "rev-parse", "HEAD^{tree}") !== manifest.bun.tree) throw new Error("Restored Bun Git identity mismatch");
  if (git(bun, "status", "--porcelain", "--untracked-files=no")) throw new Error("Restored Bun tracked source changed");
  execFileSync("bash", [join(state.workspace, "scripts/sync-bun.sh"), "--check"], { stdio: "inherit" });
  console.log(JSON.stringify({ nativeImportMs: Math.round(performance.now() - start), producerAttempt: state.identity.attempt }));
  output({ "native-ready": "true" });
}

if (import.meta.main) {
  const [command, bundle] = process.argv.slice(2);
  if ((command !== "pack" && command !== "unpack") || !bundle || !isAbsolute(bundle)) throw new Error("Usage: ci-native-handoff.ts <pack|unpack> ABSOLUTE_BUNDLE");
  const state = context();
  if (relative(state.workspace, bundle).startsWith("../") === false) throw new Error("Handoff bundle must be outside the checkout");
  if (command === "pack" && state.identity.attempt !== required("GITHUB_RUN_ATTEMPT")) throw new Error("Pack attempt is not the actual producer attempt");
  if (command === "pack") await pack(state, bundle);
  else await unpack(state, bundle);
}
