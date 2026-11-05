import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pinnedBashWeb, verifiedGuests } from "../bash-web-guests.ts";
import { selectedReleaseArchives } from "../producer-closure.ts";
import {
  draftEntries, fixtureDrafts, parseConfig, parseInputManifest, sameSource,
  type C1Config, type DonorName, type FileIdentity, type InputManifest, type NativeRoot, type SourceIdentity, type TreeIdentity,
} from "./contract.ts";
import { fileIdentity, inside, physicalPath, requireFile, requireTree, sha256, treeIdentity } from "./identity.ts";

export class AdmissionError extends Error {}
function fail(message: string): never { throw new AdmissionError(message); }

/** Where each donor is staged: product donors inside the source checkout, toolchain donors in the private root. */
const DONOR_DESTINATIONS: Readonly<Record<DonorName, { readonly root: "source" | "private"; readonly path: string }>> = {
  bun: { root: "source", path: "vendor/bun" }, boringssl: { root: "source", path: "vendor/boringssl" },
  rootDependencies: { root: "source", path: "node_modules" }, webDependencies: { root: "source", path: "web/node_modules" },
  sandboxDependencies: { root: "source", path: "sandbox/node_modules" },
  cargo: { root: "private", path: "setup/cargo-home" }, rustup: { root: "private", path: "setup/rustup" },
  tools: { root: "private", path: "setup/wasm-tools" }, bunCache: { root: "private", path: "setup/bun-cache" },
};
/** The original sysroot receipt pins these at their canonical paths; staging a copy would shadow them. */
const RECEIPT_CANONICAL_TOOLS = ["cmake", "ninja"];
const JSC_PATHS = ["build/jsc/.bunwasm-inputs", ".bunwasm-artifacts", "build/jsc/compile_commands.json", "build/jsc/CMakeCache.txt", "build/jsc/cmakeconfig.h",
  "inputs/wasi-jsc.cmake", "inputs/shim/wasi-compat.h", "inputs/shim/wasi-compat.c", "inputs/shim/madvise.c", "build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a",
  "build/jsc/lib/libbmalloc.a", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "shim/libwasi-compat.a", "jsc.wasm", "webkit/.git"];
const SDK_PATHS = ["VERSION", "lib/clang", "share/wasi-sysroot", "bin/clang", "bin/clang++", "bin/llvm-ar", "bin/wasm-ld"];
const SYSROOT_PATHS = ["bun-wasm-sysroot.json", "include", "lib/wasm32-wasip1/libc.a", "include/c++", "include/wasm32-wasip1/noeh", "lib/wasm32-wasip1/noeh/libc++.a", "lib/wasm32-wasip1/noeh/libc++abi.a"];

export interface ParsedRun {
  readonly configPath: string;
  readonly configSha256: string;
  readonly config: C1Config;
  readonly manifest: InputManifest;
}
/** One config, bound by its exact bytes, and the one manifest it names. */
export function loadRun(configPath: string): ParsedRun {
  const bytes = readFileSync(configPath);
  const config = parseConfig(JSON.parse(bytes.toString("utf8")));
  requireFile(config.manifest, "input manifest");
  const manifest = parseInputManifest(JSON.parse(readFileSync(config.manifest.path, "utf8")));
  return { configPath: resolve(configPath), configSha256: sha256(bytes), config, manifest };
}

export function git(root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", ...env }, maxBuffer: 64 * 1024 * 1024 }).trim();
}
export function cleanSource(root: string): SourceIdentity {
  if (git(root, ["status", "--porcelain", "--untracked-files=normal"])) fail(`source checkout is dirty: ${root}`);
  if (git(root, ["submodule", "status", "--recursive"]).split("\n").some(line => /^[+-U]/.test(line))) fail(`source has an unprepared submodule: ${root}`);
  return { head: git(root, ["rev-parse", "HEAD"]), tree: git(root, ["rev-parse", "HEAD^{tree}"]) };
}
/**
 * The running controller must be the selected source itself, at the
 * manifest's head and tree, before any product helper executes.
 */
function bindSource(run: ParsedRun, controllerRoot: string): SourceIdentity {
  if (realpathSync(controllerRoot) !== realpathSync(run.config.sourceRoot)) fail(`controller runs from ${controllerRoot}, not the configured source ${run.config.sourceRoot}`);
  const actual = cleanSource(run.config.sourceRoot);
  if (!sameSource(actual, run.manifest.source)) fail(`source is ${actual.head}/${actual.tree}, manifest selects ${run.manifest.source.head}/${run.manifest.source.tree}`);
  return actual;
}

function requireEntries(root: string, paths: readonly string[], label: string): void {
  for (const path of paths) if (!existsSync(join(root, path))) fail(`${label} is missing ${join(root, path)}`);
}
function sourceJson(source: string, path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(source, path), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} is not an object`);
  return value as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** Runtime, relay and programs must be the archives the selected source pins, with original program provenance. */
function admitReleases(manifest: InputManifest, source: string): void {
  const pin = sourceJson(source, "scripts/waffle-release-inputs.json");
  const runtime = requireFile(manifest.runtime.archive, "runtime archive");
  requireFile(manifest.runtime.authentication, "runtime authentication record");
  if (runtime.sha256 !== pin.sha256 || runtime.bytes !== pin.bytes || manifest.tuple.runtime !== pin.version) fail("runtime archive differs from the source's Waffle release pin");
  const selected = selectedReleaseArchives();
  if (manifest.tuple.relay !== selected.relay.version || !manifest.relay.archive.path.endsWith(`/${selected.relay.path.split("/").at(-1)}`)) fail(`relay archive is not the source's pinned relay ${selected.relay.version}`);
  requireFile(manifest.relay.archive, "relay archive");
  const programs = field(pin, "programs");
  const programPin = field(programs, "manifest");
  const programManifest = requireFile(manifest.programs.manifest, "program manifest");
  if (programManifest.sha256 !== field(programPin, "sha256") || programManifest.bytes !== field(programPin, "bytes")) fail("program manifest differs from the source's program release pin");
  if (manifest.tuple.programs !== field(programs, "tag") || manifest.tuple.programManifestSchema !== field(programs, "schema") || manifest.tuple.hostInterface !== pin.hostInterface) fail("tuple differs from the source's program release pin");
  admitProgramArchives(manifest, field(programs, "sourceCommit"));
}
function admitProgramArchives(manifest: InputManifest, sourceCommit: unknown): void {
  const value: unknown = JSON.parse(readFileSync(manifest.programs.manifest.path, "utf8"));
  const packages = field(value, "packages");
  if (field(value, "schema") !== manifest.tuple.programManifestSchema || field(value, "tag") !== manifest.tuple.programs
    || field(field(value, "runtime"), "waffleHostInterface") !== manifest.tuple.hostInterface || !Array.isArray(packages)) fail("program manifest contract differs from the tuple");
  const origin = field(value, "sourceCommit");
  if (origin !== undefined && origin !== sourceCommit) fail("program manifest origin differs from its original release; never reassign it");
  const expected = packages.map(pkg => `${String(field(pkg, "sha256"))}  ${String(field(pkg, "filename"))}\n`).join("");
  requireFile(manifest.programs.checksums, "program checksums");
  if (readFileSync(manifest.programs.checksums.path, "utf8") !== expected) fail("program checksums differ from the original manifest");
  const archives = new Map(manifest.programs.archives.map(file => [file.path.split("/").at(-1), file]));
  if (archives.size !== packages.length || manifest.programs.archives.length !== packages.length) fail("program archive inventory differs from the manifest");
  for (const pkg of packages) {
    const file = archives.get(String(field(pkg, "filename")));
    if (!file || file.sha256 !== field(pkg, "sha256") || file.bytes !== field(pkg, "bytes")) fail(`program archive ${String(field(pkg, "filename"))} differs from the manifest`);
    requireFile(file, "program archive");
  }
}

/** The original fd3 receipt states its own owner, contract and artifact; the artifact bytes must match it. */
function admitFd3(manifest: InputManifest): void {
  requireFile(manifest.fd3.receipt, "fd3 receipt");
  requireFile(manifest.fd3.artifact, "fd3 artifact");
  const receipt: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(manifest.fd3.receipt.path)));
  const contract = field(receipt, "fd3Contract");
  const artifact = field(receipt, "artifact");
  if (field(receipt, "owner") !== "Waffle network coordinator" || field(receipt, "kind") !== "new-compiled-fd3-fixture-artifact") fail("fd3 receipt owner or kind differs");
  if (field(contract, "fd") !== 3 || field(contract, "stdin") !== "unused" || JSON.stringify(field(contract, "argv")) !== "[]" || JSON.stringify(field(contract, "env")) !== "{}"
    || field(contract, "stdoutBytes") !== 12 || field(contract, "observesEof") !== true || field(contract, "exitCode") !== 0) fail("fd3 contract differs");
  if (field(artifact, "path") !== manifest.fd3.artifact.path || field(artifact, "bytes") !== manifest.fd3.artifact.bytes || field(artifact, "sha256") !== manifest.fd3.artifact.sha256
    || field(artifact, "validWebAssembly") !== true || field(artifact, "embeddedContractBytes") !== 12) fail("fd3 receipt names a different artifact");
  admitFd3Origin(receipt);
  admitFd3Module(manifest.fd3.artifact.path, artifact);
}
/** The receipt's own original source and compiler, kept as they are: never reassigned to the current runtime. */
function admitFd3Origin(receipt: unknown): void {
  const source = field(receipt, "source");
  const compiler = field(receipt, "compiler");
  const hex = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
  if (field(source, "repository") !== "Waffle" || !hex(field(source, "commit"), 40) || !hex(field(source, "tree"), 40) || typeof field(source, "path") !== "string"
    || typeof field(source, "bytes") !== "number" || !hex(field(source, "sha256"), 64)) fail("fd3 receipt lacks its original Waffle source provenance");
  if (field(compiler, "package") !== "wabt" || typeof field(compiler, "version") !== "string") fail("fd3 receipt lacks its original compiler provenance");
}
/** The receipt's import and export lists are the actual module's, parsed (never instantiated) from the admitted bytes. */
function admitFd3Module(path: string, artifact: unknown): void {
  let module: WebAssembly.Module;
  try { module = new WebAssembly.Module(readFileSync(path)); }
  catch { fail("fd3 artifact is not valid WebAssembly"); }
  const imports = WebAssembly.Module.imports(module).map(entry => ({ module: entry.module, name: entry.name, kind: entry.kind }));
  const exports = WebAssembly.Module.exports(module).map(entry => ({ name: entry.name, kind: entry.kind }));
  if (JSON.stringify(imports) !== JSON.stringify(field(artifact, "imports")) || JSON.stringify(exports) !== JSON.stringify(field(artifact, "exports"))) fail("fd3 receipt imports or exports differ from the module");
}

/** Read-only Git work: a private index and object directory, originals as alternates, no lazy fetch. */
function privateGit(repository: string, scratch: string) {
  mkdirSync(join(scratch, "objects"), { recursive: true });
  const env = { GIT_INDEX_FILE: join(scratch, "index"), GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(repository, git(repository, ["rev-parse", "--git-path", "objects"])) };
  return (args: readonly string[]) => git(repository, args, env);
}
function patchedTree(repository: string, base: string, patches: readonly string[], scratch: string, sparse = false): string {
  const command = privateGit(repository, scratch);
  command(["read-tree", base]);
  for (const patch of patches) command(["apply", "--cached", "--whitespace=nowarn", patch]);
  return command(["write-tree"].concat(sparse ? ["--missing-ok"] : []));
}
function admitBun(source: string, bun: string, scratch: string): void {
  const base = /^BUN_COMMIT=([a-f0-9]{40})$/m.exec(readFileSync(join(source, "scripts/sync-bun.sh"), "utf8"))?.[1];
  if (!base) fail("scripts/sync-bun.sh has no Bun base pin");
  cleanSource(bun);
  if (!lstatSync(join(bun, ".git")).isDirectory() || existsSync(join(bun, ".git/commondir")) || existsSync(join(bun, ".git/objects/info/alternates"))) fail("Bun donor must have independent Git metadata");
  const patches = readdirSync(join(source, "patches/bun")).filter(name => name.endsWith(".patch")).sort().map(name => join(source, "patches/bun", name));
  if (patchedTree(bun, base, patches, join(scratch, "bun")) !== git(bun, ["rev-parse", "HEAD^{tree}"])) fail("Bun donor tree differs from the source's patch series");
}
/** WebKit must be the pinned commit plus the source's patch, checked without writing its repository. */
export function admitWebkit(source: string, jsc: string, scratch: string): void {
  const webkit = join(jsc, "webkit");
  const pin = /^WEBKIT_COMMIT=([a-f0-9]{40})$/m.exec(readFileSync(join(source, "jsc/common.sh"), "utf8"))?.[1];
  if (!pin || git(webkit, ["rev-parse", "HEAD"]) !== pin) fail("WebKit is not the source's pinned commit");
  if (git(webkit, ["ls-files", "--others", "--exclude-standard"])) fail("WebKit has untracked files");
  const expected = patchedTree(webkit, pin, [join(source, "jsc/webkit-wasi.patch")], join(scratch, "webkit"), true);
  // The original index carries the sparse-checkout bits. A private copy keeps
  // them while any stat refresh git performs lands in scratch, not the original.
  const index = join(scratch, "webkit", "original-index");
  copyFileSync(resolve(webkit, git(webkit, ["rev-parse", "--git-path", "index"])), index);
  const objects = join(scratch, "webkit", "objects");
  const env = { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(webkit, git(webkit, ["rev-parse", "--git-path", "objects"])) };
  try { git(webkit, ["diff", "--quiet", expected, "--"], env); }
  catch { fail("WebKit working tree differs from the patched pin, or a needed object is missing"); }
}
function admitJsc(source: string, native: NativeRoot, roots: readonly string[], scratch: string): void {
  requireEntries(native.root, JSC_PATHS, "JSC root");
  const rows = readFileSync(join(native.root, ".bunwasm-artifacts"), "utf8").trim().split("\n");
  for (const row of rows) {
    const match = /^([a-f0-9]{64}) {2}(\/.*)$/.exec(row);
    if (!match?.[1] || !match[2] || !inside(native.root, match[2])) fail("invalid original JSC artifact list");
    if (fileIdentity(match[2]).sha256 !== match[1]) fail(`JSC archive differs from its original list: ${match[2]}`);
  }
  if (!readFileSync(join(native.root, "build/jsc/lib/libWTF.a")).includes(Buffer.from("BUN_WASM_STACK_KIB"))) fail("JSC StackBounds budget missing");
  admitCompilerPaths(native.root, roots);
  admitWebkit(source, native.root, scratch);
}
function admitCompilerPaths(jsc: string, roots: readonly string[]): void {
  const database: unknown = JSON.parse(readFileSync(join(jsc, "build/jsc/compile_commands.json"), "utf8"));
  const entry = Array.isArray(database) ? database.find(row => String(field(row, "file")).endsWith("/jsc.cpp")) : undefined;
  const command = field(entry, "command"), directory = field(entry, "directory");
  if (typeof command !== "string" || typeof directory !== "string") fail("JSC helper compilation profile missing");
  const physicalRoots = roots.map(root => realpathSync(root));
  const words = command.split(/\s+/);
  for (const [index, word] of words.entries()) {
    const path = ["-I", "-isystem", "-iquote", "-include"].includes(word) ? words[index + 1] : word.startsWith("-I") ? word.slice(2) : undefined;
    if (path && !physicalRoots.some(root => inside(root, physicalPath(resolve(directory, path))))) fail(`JSC compiler header escapes native backing: ${path}`);
  }
}
function admitSysroot(source: string, sysroot: NativeRoot, sdk: NativeRoot, donors: readonly string[]): void {
  requireEntries(sysroot.root, SYSROOT_PATHS, "sysroot");
  requireEntries(sdk.root, SDK_PATHS, "SDK");
  const receipt: unknown = JSON.parse(readFileSync(join(sysroot.root, "bun-wasm-sysroot.json"), "utf8"));
  const files = field(sourceJson(source, "scripts/waffle-release-inputs.json"), "files");
  const tools = field(receipt, "tools");
  if (!Array.isArray(tools) || "profile" in (receipt as object)) fail("sysroot receipt is not a split six-tool receipt");
  for (const tool of tools) {
    const path = field(tool, "path");
    if (typeof path !== "string" || fileIdentity(path).sha256 !== field(tool, "sha256")) fail(`original sysroot tool changed: ${String(path)}`);
    if (donors.some(root => inside(root, path))) fail(`sysroot receipt tool lies inside a staged donor: ${path}`);
  }
  if (field(receipt, "builderSha256") !== field(files, "scripts/build-wasi-libc.sh") || field(receipt, "patchSha256") !== field(files, "patches/wasi-libc/preopen-scan.patch")
    || field(receipt, "sdkVersion") !== readFileSync(join(sdk.root, "VERSION"), "utf8")) fail("sysroot receipt differs from the source's libc builder, patch or SDK");
}
/** The canonical CMake and Ninja the sysroot receipt pins; nothing staged may shadow them. */
export function receiptTools(sysroot: string): { readonly cmake: string; readonly ninja: string } {
  const tools = field(JSON.parse(readFileSync(join(sysroot, "bun-wasm-sysroot.json"), "utf8")), "tools");
  const path = (index: number) => {
    const value = Array.isArray(tools) ? field(tools[index], "path") : undefined;
    if (typeof value !== "string") fail("sysroot receipt lacks its CMake or Ninja path");
    return value;
  };
  return { cmake: path(4), ninja: path(5) };
}
function admitShell(source: string, shell: NativeRoot): void {
  const pin = pinnedBashWeb(join(source, "web"));
  try {
    if (!verifiedGuests(shell.root, pin)) fail(`shell root has no guests for bash-web ${pin}`);
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}

/** The tools donor carries exactly the selected tool trees, including the source's pinned Waffle native inputs. */
function toolSelection(source: string): string[] {
  const commit = field(sourceJson(source, "scripts/waffle-release-inputs.json"), "sourceCommit");
  return ["cmake", "ninja", "binaryen", "wasm-tools-bin", "wasmtime", "wasi-sdk/bin", "wasi-sdk/lib", "wasi-sdk/share", "wasi-sdk/VERSION", `waffle-native/${String(commit)}`];
}
export function stagedSelection(name: DonorName, source: string): readonly string[] | undefined {
  return name === "tools" ? toolSelection(source).filter(path => !RECEIPT_CANONICAL_TOOLS.includes(path)) : undefined;
}
function admitDonors(manifest: InputManifest, source: string, scratch: string): void {
  for (const [name, tree] of Object.entries(manifest.donors) as [DonorName, TreeIdentity][]) requireTree(tree, `donor ${name}`, name === "tools" ? toolSelection(source) : undefined);
  admitBun(source, manifest.donors.bun.path, scratch);
  for (const [name, directory] of [["rootDependencies", ""], ["webDependencies", "web"], ["sandboxDependencies", "sandbox"]] as const) {
    for (const file of ["package.json", "bun.lock"]) {
      if (fileIdentity(join(dirname(manifest.donors[name].path), file)).sha256 !== fileIdentity(join(source, directory, file)).sha256) fail(`${name} was not installed from the source's frozen ${file}`);
    }
  }
}
function admitTools(manifest: InputManifest): void {
  for (const [name, tool] of Object.entries(manifest.tools)) {
    requireFile(tool, `tool ${name}`);
    try { accessSync(tool.path, constants.X_OK); } catch { fail(`tool ${name} is not executable: ${tool.path}`); }
  }
}

/** Every external path the run reads; no writable root may overlap one. */
export function protectedPaths(run: ParsedRun): string[] {
  const m = run.manifest;
  const files: FileIdentity[] = [m.runtime.archive, m.runtime.authentication, m.relay.archive, m.programs.manifest, m.programs.checksums, m.fd3.artifact, m.fd3.receipt, run.config.manifest]
    .concat(m.programs.archives, Object.values(m.tools), Object.values(m.native).flatMap(root => root.files));
  const roots = Object.values(m.native).map(root => root.root).concat(Object.values(m.donors).map(tree => tree.path), [m.consumers.browsers.path]);
  return [run.config.sourceRoot, run.configPath].concat(roots, files.map(file => file.path), tlsDependencyPaths(m));
}
function tlsDependencyPaths(manifest: InputManifest): string[] {
  const tls = manifest.consumers.tls;
  if (tls.status !== "resolved") return [];
  return [tls.value.pgModules.path, tls.value.pgTarball.path, tls.value.pgPackageJson.path, tls.value.pgLock.path];
}
/**
 * A resolved TLS dependency closure is admitted like every other input: the
 * pinned public tarball, the complete installed tree (no link may leave it)
 * and the frozen package manifest and lock it was installed from.
 */
function admitTlsDependencies(manifest: InputManifest): void {
  const tls = manifest.consumers.tls;
  if (tls.status !== "resolved") return;
  const { pgTarball, pgModules, pgPackageJson, pgLock } = tls.value;
  requireFile(pgTarball, "pg tarball");
  requireFile(pgPackageJson, "pg frozen package manifest");
  requireFile(pgLock, "pg frozen lock");
  requireTree(pgModules, "pg installed dependency tree");
  if (pgPackageJson.path !== join(dirname(pgModules.path), "package.json") || pgLock.path !== join(dirname(pgModules.path), "bun.lock")) fail("pg tree was not installed beside its frozen package manifest and lock");
}

export interface Authenticated {
  readonly run: ParsedRun;
  readonly source: SourceIdentity;
  /** Entries that are still draft or unresolved. Production refuses unless this is empty. */
  readonly drafts: readonly string[];
}
/**
 * Byte and receipt admission of every input, read-only: originals are only
 * read, Git work happens in `scratch`. Verified native roots run their full
 * validators; draft roots are reported, never treated as admitted.
 */
export function authenticate(run: ParsedRun, controllerRoot: string, scratch: string): Authenticated {
  const source = bindSource(run, controllerRoot);
  const m = run.manifest;
  const sourceRoot = run.config.sourceRoot;
  admitReleases(m, sourceRoot);
  admitFd3(m);
  admitTools(m);
  admitDonors(m, sourceRoot, scratch);
  for (const native of Object.values(m.native)) {
    for (const file of native.files) requireFile(file, "native backing file");
    if (native.provenance.status === "verified") for (const receipt of native.provenance.receipts) requireFile(receipt, "native receipt");
  }
  if (m.relay.provenance.status === "verified") for (const receipt of m.relay.provenance.receipts) requireFile(receipt, "relay receipt");
  const donors = Object.values(m.donors).map(tree => tree.path);
  if (m.native.jsc.provenance.status === "verified") admitJsc(sourceRoot, m.native.jsc, [m.native.jsc.root, m.native.sdk.root, m.native.sysroot.root], scratch);
  if (m.native.sysroot.provenance.status === "verified") admitSysroot(sourceRoot, m.native.sysroot, m.native.sdk, donors);
  if (m.native.shell.provenance.status === "verified") admitShell(sourceRoot, m.native.shell);
  requireTree(m.consumers.browsers, "Playwright browsers");
  admitTlsDependencies(m);
  return { run, source, drafts: draftEntries(m).concat(fixtureDrafts(run.config.fixtures)) };
}

/** Staged destination of a donor, from its owning root. */
export function donorDestination(name: DonorName, sourceRoot: string, privateRoot: string): string {
  const destination = DONOR_DESTINATIONS[name];
  return join(destination.root === "source" ? sourceRoot : privateRoot, destination.path);
}
/** A staged copy must have its donor's identity (over the staged selection) at its destination. */
export function requireStagedDonor(name: DonorName, donor: TreeIdentity, destination: string, source: string): void {
  const selection = stagedSelection(name, source);
  const expected = selection ? treeIdentity(donor.path, selection) : donor;
  const actual = treeIdentity(destination, selection);
  if (actual.sha256 !== expected.sha256 || actual.files !== expected.files || actual.bytes !== expected.bytes) fail(`staged ${name} differs from its donor`);
}
