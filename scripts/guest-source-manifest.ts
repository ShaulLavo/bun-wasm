import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const guestBuilds = {
  browser: { artifact: "bun-browser.wasm", package: "bunwasm-cli", features: ["engine-host", "bun-transpiler", "bun-build"] },
  quickjs: { artifact: "bun.wasm", package: "bunwasm-cli", features: ["default"] },
  "quickjs-minimal": { artifact: "bun.wasm", package: "bunwasm-cli", features: [] },
  jsc: { artifact: "bun-jsc.wasm", package: "bunwasm-cli", features: ["engine-jsc", "bun-transpiler", "bun-build"] },
  tools: { artifact: "bun-tools.wasm", package: "bunwasm-tools", features: ["default"] },
} as const;
export type GuestBuild = keyof typeof guestBuilds;
export const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export interface InputFile { readonly path: string; readonly sha256: string; readonly bytes: number }
export interface InputGroup { readonly name: string; readonly files: readonly InputFile[] }
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
  readonly tools: Readonly<Record<string, string>>;
  readonly jscBuild: string | undefined;
}

export function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdin: "ignore" });
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

async function repositoryGroup(repository: string): Promise<InputGroup> {
  if (git(repository, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Guest repository source must be committed and clean");
  const paths = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "env.sh", "package.json", "bun.lock", "crates", "third_party", "scripts", "patches", "jsc"];
  const entries = git(repository, "ls-tree", "-rz", "HEAD", "--", ...paths).split("\0").filter(Boolean);
  const files: InputFile[] = [];
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error("Guest repository inputs must be regular committed files");
    const [, , object, path] = match;
    if (!path) throw new Error("Missing committed input path");
    const absolute = join(repository, path);
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error(`Symlink in repository inputs: ${path}`);
    const bytes = await readFile(absolute);
    const blob = new Bun.CryptoHasher("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
    if (blob !== object) throw new Error(`Guest repository input differs from committed source: ${path}`);
    files.push({ path, sha256: hash(bytes), bytes: bytes.byteLength });
  }
  return { name: "repository", files };
}

async function tool(name: string, path: string, repository: string) {
  const physical = await realpath(path);
  const flags = name === "rustc" ? ["-vV"] : name === "cargo" ? ["-Vv"] : ["--version"];
  return { name, path: physical, sha256: (await fingerprint(physical)).sha256, version: run([path].concat(flags), repository) };
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

export async function captureSourceManifest(options: SourceOptions): Promise<SourceManifest> {
  const { repository, build, sysroot, sdk, waffle, boringssl, rustTargetLib } = options;
  const source = { head: git(repository, "rev-parse", "HEAD"), tree: git(repository, "rev-parse", "HEAD^{tree}") };
  const groups = [await repositoryGroup(repository)];
  groups.push(await group("bun", join(repository, "vendor/bun"), ["src", "Cargo.toml", "Cargo.lock", "build/debug/codegen", "vendor/lolhtml", "vendor/rust-argon2"]));
  if (build !== "tools") groups.push(await group("boringssl", boringssl, ["CMakeLists.txt", "cmake", "include", "crypto", "gen", "third_party", "util"]));
  groups.push(await group("waffle-libc", waffle, ["package.json", "scripts/build-wasi-libc.sh", "patches/wasi-libc/preopen-scan.patch"]));
  groups.push(await group("sysroot", sysroot, ["bun-wasm-sysroot.json", "include", "lib"], [sdk]));
  groups.push(await group("sdk", sdk, ["VERSION", "lib/clang"]));
  groups.push(await group("rust-target", rustTargetLib, ["."]));
  await verifySysrootInputs(options, groups);
  if (build === "jsc" || build === "tools") {
    if (!options.jscBuild) throw new Error("JSC build requires JSC_BUILD_DIR");
    groups.push(await group("jsc-prebuild", options.jscBuild, ["build/jsc/.bunwasm-inputs", "build/jsc/compile_commands.json", "inputs/wasi-jsc.cmake", "inputs/shim/wasi-compat.h", "build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a", "build/jsc/lib/libbmalloc.a", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "shim/libwasi-compat.a"]));
  }
  const tools = await Promise.all(Object.entries(options.tools).map(([name, path]) => tool(name, path, repository)));
  if (git(repository, "rev-parse", "HEAD") !== source.head || git(repository, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Guest source changed while collecting manifest");
  return {
    schema: 1, build, source, groups, tools,
    omissions: [
      "Allowlisted snapshots include source/config supersets, not an observed compiler dependency graph or proof of execution.",
      "Cargo registry/git cache source bytes are not inventoried; Cargo.lock records resolutions and registry checksums.",
      "Ambient environment, user/global Cargo configuration, host shared libraries and intermediate build-cache provenance are not inventoried.",
      "Waffle browser runtime is not compiled into this guest; only its installed libc builder and patch are inventoried.",
      "JSC/tools prebuild archives, compiler flags and input stamp identify linked inputs; WebKit/ICU headers and full prebuild source closure are not inventoried. JSC embedding receipt remains separate.",
    ],
  };
}

export function sourceOptions(repository: string, sysroot: string, build: GuestBuild): SourceOptions {
  const sdk = process.env.WASI_SDK_PATH;
  if (!sdk) throw new Error("Source env.sh before recording guest inputs");
  if (process.env.BUN_CODEGEN_DIR && resolve(process.env.BUN_CODEGEN_DIR) !== join(repository, "vendor/bun/build/debug/codegen")) throw new Error("Guest manifest requires the default Bun codegen directory");
  if (process.env.WASI_SDK && realpathSync(process.env.WASI_SDK) !== realpathSync(sdk)) throw new Error("WASI_SDK must match WASI_SDK_PATH for a guest manifest");
  const compiler = (name: string) => run(["rustup", "which", name], repository);
  const rustc = process.env.RUSTC ?? compiler("rustc");
  const tools: Record<string, string> = { rustc, cargo: compiler("cargo"), bun: process.execPath };
  for (const name of ["clang", "clang++", "llvm-ar", "wasm-ld"]) tools[name] = join(sdk, "bin", name);
  for (const name of ["cmake", "ninja", "wasm-opt"]) {
    const path = Bun.which(name);
    if (!path && name === "wasm-opt" && (build === "quickjs" || build === "quickjs-minimal")) continue;
    if (!path) throw new Error(`Missing guest tool: ${name}`);
    tools[name] = path;
  }
  return {
    repository, sysroot, build, sdk, tools,
    waffle: resolve(realpathSync(Bun.resolveSync("waffle/package.json", repository)), ".."),
    boringssl: process.env.BUNWASM_BORINGSSL_SOURCE ?? join(repository, "vendor/boringssl"),
    rustTargetLib: run([rustc, "--print", "target-libdir", "--target", "wasm32-wasip1"], repository),
    jscBuild: process.env.JSC_BUILD_DIR ?? "/work/tmp/bun-wasm-jsc",
  };
}
