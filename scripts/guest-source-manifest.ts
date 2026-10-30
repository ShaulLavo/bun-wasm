import { programKindForBuild } from "../src/engine-kind.ts";
import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { waffleNativeDirectory } from "./waffle-release-inputs";

export const guestBuilds = {
  browser: { artifact: "bun-browser.wasm", package: "bunwasm-cli", features: ["engine-host", "bun-transpiler", "bun-build"], optimizer: "required" },
  "source-cache-browser": { artifact: "bun-browser.wasm", package: "bunwasm-cli", features: ["engine-host", "bun-build"], optimizer: "unused" },
  quickjs: { artifact: "bun.wasm", package: "bunwasm-cli", features: ["engine-split", "bun-transpiler", "bun-build"], optimizer: "required" },
  "quickjs-minimal": { artifact: "bun.wasm", package: "bunwasm-cli", features: ["engine-split"], optimizer: "required" },
  jsc: { artifact: "bun-jsc.wasm", package: "bunwasm-cli", features: ["engine-split", "bun-transpiler", "bun-build"], optimizer: "required" },
  hermes: { artifact: "bun-hermes.wasm", package: "bunwasm-cli", features: ["engine-split", "bun-transpiler", "bun-build"], optimizer: "required" },
  tools: { artifact: "bun-tools.wasm", package: "bunwasm-tools", features: ["default"], optimizer: "required" },
} as const;
export type GuestBuild = keyof typeof guestBuilds;
export const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

interface InputFile { readonly path: string; readonly sha256: string; readonly bytes: number }
interface InputGroup { readonly name: string; readonly files: readonly InputFile[] }
export interface SourceManifest {
  readonly schema: 1;
  readonly build: GuestBuild;
  readonly source: { readonly head: string; readonly tree: string };
  readonly groups: readonly InputGroup[];
  readonly tools: readonly { readonly name: string; readonly path: string; readonly sha256: string; readonly version: string }[];
  readonly omissions: readonly string[];
}

export interface SourceOptions {
  readonly repository: string;
  readonly build: GuestBuild;
  readonly sysroot: string;
  readonly sdk: string;
  readonly waffle: string;
  readonly boringssl: string;
  readonly rustTargetLib: string;
  readonly rustSourceLib: string | undefined;
  readonly tools: Readonly<Record<string, string>>;
  readonly jscBuild: string | undefined;
  readonly hermesBuild: string;
}

export function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = Bun.spawnSync(command, { cwd, stdin: "ignore", env: { ...env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.exitCode !== 0) throw new Error(`Guest source check failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function git(repository: string, ...args: string[]): string {
  return run(["git", "-C", repository].concat(args), repository);
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

async function fingerprint(path: string): Promise<{ sha256: string; bytes: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hasher.digest("hex"), bytes };
}

async function inputFiles(root: string, path: string, allowedRoots: readonly string[], ancestors: readonly string[] = []): Promise<InputFile[]> {
  const absolute = join(root, path);
  const physical = await realpath(absolute);
  if (!allowedRoots.some(allowed => inside(allowed, physical))) throw new Error(`Source input escapes allowlist: ${path}`);
  if (ancestors.includes(physical)) throw new Error(`Cyclic source input: ${path}`);
  const metadata = await lstat(physical);
  if (metadata.isFile()) {
    return [{ path, ...await fingerprint(physical) }];
  }
  if (!metadata.isDirectory()) throw new Error(`Unsupported source input: ${path}`);
  const names = (await readdir(physical)).filter(name => name !== ".git").sort();
  let files: InputFile[] = [];
  for (const name of names) files = files.concat(await inputFiles(root, join(path, name), allowedRoots, ancestors.concat([physical])));
  return files;
}

async function group(name: string, root: string, paths: readonly string[], linkedRoots: readonly string[] = []): Promise<InputGroup> {
  const allowed = await Promise.all([root].concat(linkedRoots).map(path => realpath(path)));
  let files: InputFile[] = [];
  for (const path of paths) files = files.concat(await inputFiles(root, path, allowed));
  return { name, files };
}

type ImportedLinks = "reject" | "within-repository";
async function committedInput(repository: string, path: string, mode: string, links: ImportedLinks): Promise<Uint8Array> {
  const absolute = join(repository, path);
  const metadata = await lstat(absolute);
  if (mode !== "120000") {
    if (!metadata.isFile()) throw new Error(`Repository input must remain a regular file: ${path}`);
    return readFile(absolute);
  }
  if (links === "reject" || !metadata.isSymbolicLink()) throw new Error(`Unsupported symlink in repository inputs: ${path}`);
  if (!inside(await realpath(repository), await realpath(absolute))) throw new Error(`Source link escapes imported repository: ${path}`);
  return readlink(absolute, { encoding: "buffer" });
}

async function committedGroup(name: string, repository: string, paths: readonly string[], links: ImportedLinks = "reject", exclude: (path: string) => boolean = () => false): Promise<InputGroup> {
  if (git(repository, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Guest repository source must be committed and clean");
  const entries = git(repository, "ls-tree", "-rz", "HEAD", "--", ...paths).split("\0").filter(Boolean);
  const files: InputFile[] = [];
  for (const entry of entries) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error("Guest repository inputs must be regular committed files");
    const [, mode, object, path] = match;
    if (!path || !mode) throw new Error("Missing committed input path or mode");
    if (exclude(path)) continue;
    const bytes = await committedInput(repository, path, mode, links);
    const blob = new Bun.CryptoHasher("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
    if (blob !== object) throw new Error(`Guest repository input differs from committed source: ${path}`);
    files.push({ path, sha256: hash(bytes), bytes: bytes.byteLength });
  }
  return { name, files };
}

async function tool(name: string, path: string, repository: string) {
  const physical = await realpath(path);
  const flags = name === "rustc" ? ["-vV"] : name === "cargo" ? ["-Vv"] : name === "rust-lld" ? ["-flavor", "wasm", "--version"] : ["--version"];
  const env = { ...process.env };
  delete env.LLD_REPRODUCE;
  return { name, path: physical, sha256: (await fingerprint(physical)).sha256, version: run([path].concat(flags), repository, env) };
}

async function verifySysrootInputs(options: SourceOptions, groups: readonly InputGroup[]): Promise<void> {
  const receipt: unknown = await Bun.file(join(options.sysroot, "bun-wasm-sysroot.json")).json();
  if (!receipt || typeof receipt !== "object" || !("builderSha256" in receipt) || !("patchSha256" in receipt) || !("libcSha256" in receipt) || !("sdkVersion" in receipt)) throw new Error("Invalid patched sysroot receipt");
  const waffle = groups.find(group => group.name === "waffle-libc");
  const sysroot = groups.find(group => group.name === "sysroot");
  if (waffle?.files.find(file => file.path === "scripts/build-wasi-libc.sh")?.sha256 !== receipt.builderSha256
    || waffle?.files.find(file => file.path === "patches/wasi-libc/preopen-scan.patch")?.sha256 !== receipt.patchSha256
    || sysroot?.files.find(file => file.path === "lib/wasm32-wasip1/libc.a")?.sha256 !== receipt.libcSha256
    || await Bun.file(join(options.sdk, "VERSION")).text() !== receipt.sdkVersion) throw new Error("Patched sysroot receipt does not match installed builder, patch, SDK or libc bytes");
}

export type ProgramInputScope = "core" | "quickjs" | "jsc" | "hermes";

export async function captureSourceManifest(options: SourceOptions, scope: "guest" | ProgramInputScope = "guest", includeBuildStd = false): Promise<SourceManifest> {
  const { repository, build, sysroot, sdk, waffle, boringssl, rustTargetLib } = options;
  const source = { head: git(repository, "rev-parse", "HEAD"), tree: git(repository, "rev-parse", "HEAD^{tree}") };
  const repositoryPaths = scope === "guest"
    ? ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "env.sh", "package.json", "bun.lock", "crates", "third_party", "scripts", "patches", "jsc", "src/engine-kind.ts", "src/quickjs-program.ts", "web/src/native-direct-stream.ts", "web/src/shared-objects/lane.ts"]
    : scopedRepositoryPaths(scope);
  const groups = [await committedGroup("repository", repository, repositoryPaths, "reject", path => scope === "core" && /^(crates\/bunwasm-(engine-quickjs|engine-jsc|jsc|engine-hermes|hermes)\/|third_party\/rquickjs)/.test(path))];
  const bun = join(repository, "vendor/bun");
  if (scope === "guest" || scope === "core") {
    await committedGroup("bun", bun, ["src", "Cargo.toml", "Cargo.lock"], "within-repository");
    groups.push(await group("bun", bun, ["src", "Cargo.toml", "Cargo.lock", "build/debug/codegen", "vendor/lolhtml", "vendor/rust-argon2"]));
    groups.push(await group("boringssl", boringssl, ["CMakeLists.txt", "cmake", "include", "crypto", "gen", "third_party", "util", "decrepit/cfb/cfb.cc", "decrepit/blowfish/blowfish.cc", "decrepit/macros.h"]));
  }
  if (scope === "jsc") groups.push(await committedGroup("bun-version", bun, ["package.json"]));
  groups.push(await group("waffle-libc", waffle, ["package.json", "scripts/build-wasi-libc.sh", "patches/wasi-libc/preopen-scan.patch"]));
  groups.push(await group("sysroot", sysroot, ["bun-wasm-sysroot.json", "include", "lib"], [sdk]));
  groups.push(await group("sdk", sdk, ["VERSION", "lib/clang"]));
  groups.push(await group("rust-target", rustTargetLib, ["."]));
  if (programKindForBuild(build) !== "single" || includeBuildStd) {
    if (!options.rustSourceLib) throw new Error("Engine program build requires Rust build-std source inputs");
    groups.push(await group("rust-build-std", options.rustSourceLib, ["."]));
  }
  await verifySysrootInputs(options, groups);
  const absentHeaderSearchPaths: string[] = [];
  if (build === "jsc" || build === "tools") {
    if (!options.jscBuild) throw new Error("JSC build requires JSC_BUILD_DIR");
    const paths = ["build/jsc/.bunwasm-inputs", "build/jsc/compile_commands.json", "inputs/wasi-jsc.cmake", "inputs/shim/wasi-compat.h", "build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a", "build/jsc/lib/libbmalloc.a", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "shim/libwasi-compat.a"];
    if (build === "tools") paths.push("webkit/Source/JavaScriptCore/yarr", "webkit/Source/JavaScriptCore/runtime/OptionsList.h", "build/jsc/JavaScriptCore/DerivedSources/yarr/YarrCanonicalizeUnicode.cpp");
    const headers = scope === "jsc" ? await jscHeaderPaths(options) : undefined;
    if (headers) {
      paths.push(".bunwasm-artifacts", "build/jsc/CMakeCache.txt", "build/jsc/cmakeconfig.h", ...headers.prebuild);
      absentHeaderSearchPaths.push(...headers.absent);
    }
    groups.push(await group("jsc-prebuild", options.jscBuild, Array.from(new Set(paths)).sort()));
    if (headers?.sdk.length) groups.push(await group("jsc-helper-sdk-headers", sdk, Array.from(new Set(headers.sdk)).sort()));
    if (headers?.sysroot.length) groups.push(await group("jsc-helper-sysroot-headers", sysroot, Array.from(new Set(headers.sysroot)).sort(), [sdk]));
  }
  if (build === "hermes") {
    groups.push(await group("hermes-prebuild", options.hermesBuild, ["wasi/lib/libhermesvm_bunwasm.a", "wasi/compile_commands.json"]));
  }
  const tools = await Promise.all(Object.entries(options.tools).map(([name, path]) => tool(name, path, repository)));
  if (git(repository, "rev-parse", "HEAD") !== source.head || git(repository, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Guest source changed while collecting manifest");
  return {
    schema: 1, build, source, groups, tools,
    omissions: [
      "Allowlisted start/end snapshots detect persistent drift, not changes restored between snapshots, an observed compiler dependency graph or proof of execution.",
      "Cargo registry/git cache source bytes are not inventoried; Cargo.lock records resolutions and registry checksums.",
      "Ambient environment, user/global Cargo configuration, host shared libraries and intermediate build-cache provenance are not inventoried.",
      "Waffle browser runtime is not compiled into this guest; only its checksum-verified released-source libc builder and patch are inventoried.",
      "JSC/tools prebuild archives, compiler flags and input stamp identify linked inputs; direct tools Yarr sources are inventoried, but remaining WebKit/ICU headers and full prebuild source closure are not. JSC embedding receipt remains separate.",
    ].concat(absentHeaderSearchPaths.length ? [
      `JSC compiler search paths absent at capture (bound by this snapshot): ${JSON.stringify(absentHeaderSearchPaths.sort())}`,
    ] : []),
  };
}

function scopedRepositoryPaths(scope: ProgramInputScope): string[] {
  const common = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "env.sh", "scripts/guest-source-manifest.ts", "scripts/guest-build-receipt.ts", "scripts/guest-core-receipt.ts", "scripts/guest-engine-receipt.ts", "scripts/src/program-profile.ts", "src/engine-kind.ts"];
  if (scope === "core") return common.concat(["crates", "third_party", "patches", "scripts/build-bun-core.sh", "scripts/quickjs-core-exports.txt", "scripts/src/engine-explicit-init.ts",
    "scripts/transpile-runtime.ts", "scripts/generate-bun-wrap.ts", "scripts/generate-node-path.ts", "scripts/generate-direct-stream.ts", "web/src/native-direct-stream.ts", "scripts/generate-shared-lane.ts", "web/src/shared-objects/lane.ts", "jsc/wasi-jsc.cmake", "scripts/check-cmake-cache.cmake"]);
  const shared = ["engine.rs", "data.rs", "data/codec.rs", "ops.rs", "ops", "split_api.rs"].map(path => `crates/bunwasm-runtime/src/${path}`);
  const program = ["driver.rs", "client.rs", "loader.rs", "program.rs", "natives.rs", "value_natives.rs", "allocator.rs", "transport.rs", "side_modules.rs"].map(path => `crates/bunwasm-engine-quickjs/src/${path}`);
  const owned = {
    quickjs: ["crates/bunwasm-engine-quickjs", "third_party/rquickjs", "third_party/rquickjs-sys"],
    jsc: ["crates/bunwasm-engine-jsc", "crates/bunwasm-jsc", "jsc"],
    hermes: ["crates/bunwasm-engine-hermes", "crates/bunwasm-hermes", "hermes"],
  };
  const own = owned[scope];
  return common.concat(shared, program, own, [`scripts/build-engine-${scope}.sh`, "scripts/src/engine-explicit-init.ts", "scripts/src/engine-init.c"]);
}

type HeaderRoot = "prebuild" | "sdk" | "sysroot";
type HeaderPaths = Record<HeaderRoot, string[]> & { absent: string[] };
async function jscHeaderPaths(options: SourceOptions): Promise<HeaderPaths> {
  const build = options.jscBuild;
  if (!build) throw new Error("Missing JSC prebuild root");
  const database: unknown = JSON.parse(await readFile(join(build, "build/jsc/compile_commands.json"), "utf8"));
  if (!Array.isArray(database)) throw new Error("Invalid JSC compilation database");
  const entry: unknown = database.find(row => row && typeof row === "object" && "file" in row && typeof row.file === "string" && row.file.endsWith("/jsc.cpp"));
  if (!entry || typeof entry !== "object" || !("command" in entry) || typeof entry.command !== "string" || !("directory" in entry) || typeof entry.directory !== "string") throw new Error("Missing JSC helper compilation profile");
  const words = entry.command.split(/\s+/);
  const paths: HeaderPaths = { prebuild: [], sdk: [], sysroot: [], absent: [] };
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    const separate = ["-I", "-isystem", "-iquote", "-include"].includes(word);
    const path = separate ? words[++index] : /^-I.+/.test(word) ? word.slice(2) : undefined;
    if (!path && separate) throw new Error(`Missing JSC compiler input for ${word}`);
    if (!path) continue;
    const checked = await checkedHeaderPath(path, entry.directory, options, word !== "-include");
    if (checked.absent) paths.absent.push(`${checked.root}:${checked.path}`);
    else paths[checked.root].push(checked.path);
  }
  return paths;
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonicalAbsentSearchPath(path: string): Promise<string> {
  let ancestor = path;
  while (true) {
    let exists = false;
    try { await lstat(ancestor); exists = true; }
    catch (error) { if (!missingPath(error)) throw error; }
    if (exists) return resolve(await realpath(ancestor), relative(ancestor, path));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`No existing ancestor for compiler search path ${path}`);
    ancestor = parent;
  }
}

async function checkedHeaderPath(path: string, directory: string, options: SourceOptions, search: boolean): Promise<{ root: HeaderRoot; path: string; absent: boolean }> {
  const input = resolve(directory, path);
  let absolute: string;
  let absent = false;
  try { absolute = await realpath(input); }
  catch (error) {
    if (!search || !missingPath(error)) throw error;
    absolute = await canonicalAbsentSearchPath(input);
    absent = true;
  }
  const prebuild = options.jscBuild;
  if (!prebuild) throw new Error("Missing JSC prebuild root");
  const roots: readonly [HeaderRoot, string][] = [["prebuild", prebuild], ["sysroot", options.sysroot], ["sdk", options.sdk]];
  for (const [name, path] of roots) {
    const root = await realpath(path);
    if (inside(root, absolute)) return { root: name, path: relative(root, absolute), absent };
  }
  throw new Error(`JSC helper header input escapes inventoried roots: ${path}`);
}

function rustTools(repository: string) {
  for (const name of ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]) {
    if (process.env[name]) throw new Error(`${name} is not supported for qualified guest receipts`);
  }
  for (const name of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS"]) {
    if (/linker\s*=/.test(process.env[name] ?? "")) throw new Error(`${name} linker override is not supported for qualified guest receipts`);
  }
  const rustc = realpathSync(run(["rustup", "which", "rustc"], repository));
  if (process.env.RUSTC && realpathSync(process.env.RUSTC) !== rustc) throw new Error("RUSTC must be the active Rustup compiler executable, not a dispatcher or override");
  const sysroot = run([rustc, "--print", "sysroot"], repository);
  const host = /^host: (.+)$/m.exec(run([rustc, "-vV"], repository))?.[1];
  if (!host || !/^[a-zA-Z0-9_-]+$/.test(host)) throw new Error("Missing Rust compiler host identity");
  const linker = realpathSync(join(sysroot, "lib/rustlib", host, "bin/rust-lld"));
  const selected = process.env.CARGO_TARGET_WASM32_WASIP1_LINKER;
  if (selected && realpathSync(selected) !== linker) throw new Error("CARGO_TARGET_WASM32_WASIP1_LINKER must be the active compiler's rust-lld");
  const cargo = realpathSync(run(["rustup", "which", "cargo"], repository));
  if (process.env.GUEST_CARGO && realpathSync(process.env.GUEST_CARGO) !== cargo) throw new Error("GUEST_CARGO must be the active Rustup Cargo executable");
  return { rustc, cargo, "rust-lld": linker };
}

function nodeExecutable(repository: string): string {
  const path = run(["node", "-p", "process.execPath"], repository);
  if (!isAbsolute(path)) throw new Error("Node must report its actual executable path");
  return realpathSync(path);
}

export function guestToolEnvironment(repository: string): string {
  const tools = rustTools(repository);
  const node = nodeExecutable(repository);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return [
    `export RUSTC=${quote(tools.rustc)}`,
    `export GUEST_CARGO=${quote(tools.cargo)}`,
    `export CARGO_TARGET_WASM32_WASIP1_LINKER=${quote(tools["rust-lld"])}`,
    "export RUSTC_WRAPPER='' RUSTC_WORKSPACE_WRAPPER=''",
    `export PATH=${quote(dirname(node))}:"$PATH"`,
  ].join("\n");
}

export function sourceOptions(repository: string, sysroot: string, build: GuestBuild): SourceOptions {
  if (process.env.BUNWASM_JS_OVERRIDE_DIR !== undefined) throw new Error("BUNWASM_JS_OVERRIDE_DIR is not supported for qualified guest receipts");
  const sdk = process.env.WASI_SDK_PATH;
  if (!sdk) throw new Error("Source env.sh before recording guest inputs");
  if (process.env.BUN_CODEGEN_DIR && resolve(process.env.BUN_CODEGEN_DIR) !== join(repository, "vendor/bun/build/debug/codegen")) throw new Error("Guest manifest requires the default Bun codegen directory");
  if (process.env.WASI_SDK && realpathSync(process.env.WASI_SDK) !== realpathSync(sdk)) throw new Error("WASI_SDK must match WASI_SDK_PATH for a guest manifest");
  const rust = rustTools(repository);
  const tools: Record<string, string> = { ...rust, node: nodeExecutable(repository), bun: process.execPath };
  for (const name of ["clang", "clang++", "llvm-ar", "wasm-ld"]) tools[name] = join(sdk, "bin", name);
  const optimizer = guestBuilds[build].optimizer;
  for (const name of ["cmake", "ninja", "wasm-opt"]) {
    if (name === "wasm-opt" && optimizer === "unused") continue;
    const path = Bun.which(name);
    if (!path) throw new Error(`Missing guest tool: ${name}`);
    tools[name] = path;
  }
  return {
    repository, sysroot, build, sdk, tools,
    waffle: waffleNativeDirectory(),
    boringssl: process.env.BUNWASM_BORINGSSL_SOURCE ?? join(repository, "vendor/boringssl"),
    rustTargetLib: run([rust.rustc, "--print", "target-libdir", "--target", "wasm32-wasip1"], repository),
    rustSourceLib: programKindForBuild(build) === "single" ? undefined : join(run([rust.rustc, "--print", "sysroot"], repository), "lib/rustlib/src/rust/library"),
    jscBuild: process.env.JSC_BUILD_DIR ?? "/work/tmp/bun-wasm-jsc",
    hermesBuild: process.env.HERMES_BUILD_DIR ?? "/work/tmp/bun-wasm-hermes",
  };
}
