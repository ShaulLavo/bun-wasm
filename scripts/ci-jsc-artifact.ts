import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

type Profile = "split" | "shared-group";
type Category = "jsc-build" | "webkit" | "icu-prefix" | "inputs" | "shim" | "libcxx-final" | "receipts-and-other" | "icu-producer" | "libcxx-producer" | "gems" | "producer-logs";
type Entry = { readonly path: string; readonly kind: "directory" | "file" | "symlink" };
type Count = { retained_regular_file_bytes: number; excluded_regular_file_bytes: number };
type Inventory = { readonly entries: Map<string, Entry>; readonly excluded: string[]; readonly bytes: Map<Category, Count> };
type Options = { readonly root: string; readonly profile: Profile; readonly sdk: string; readonly sysroot: string };

const artifacts = ["build/jsc/lib/libJavaScriptCore.a", "build/jsc/lib/libWTF.a", "build/jsc/lib/libbmalloc.a", "icu/prefix/lib/libicuuc.a", "icu/prefix/lib/libicui18n.a", "icu/prefix/lib/libicudata.a", "shim/libwasi-compat.a", "build/jsc/CMakeCache.txt", "build/jsc/compile_commands.json", "build/jsc/cmakeconfig.h"];
const inputs = [".bunwasm-artifacts", "build/jsc/.bunwasm-inputs", "icu/.bunwasm-inputs", "inputs/wasi-jsc.cmake", "inputs/shim/wasi-compat.h", "inputs/shim/wasi-compat.c", "inputs/shim/madvise.c", "webkit/.git/HEAD", "webkit/.git/index", "webkit/.git/config", "webkit/.git/info/sparse-checkout", "webkit/Source/JavaScriptCore/runtime/OptionsList.h", "build/jsc/JavaScriptCore/DerivedSources/yarr/YarrCanonicalizeUnicode.cpp"];
const yarr = ["YarrPattern.cpp", "YarrInterpreter.cpp", "YarrCanonicalizeUCS2.cpp", "YarrErrorCode.cpp", "YarrFlags.cpp", "YarrUnicodeProperties.cpp"];

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

function category(path: string, profile: Profile): { category: Category; retain: boolean } {
  if (/^icu\/(host-src|wasm-src|data)(\/|$)/.test(path) || /^icu\/icu4c-[\d.]+-sources\.tgz$/.test(path)) return { category: "icu-producer", retain: false };
  if (profile === "shared-group" && /^libcxx\/(build|llvm-project)(\/|$)/.test(path)) return { category: "libcxx-producer", retain: false };
  if (/^gems(\/|$)/.test(path)) return { category: "gems", retain: false };
  const roots: readonly [string, Category][] = [["build/jsc", "jsc-build"], ["webkit", "webkit"], ["icu/prefix", "icu-prefix"], ["inputs", "inputs"], ["shim", "shim"], ["libcxx/lib", "libcxx-final"], ["libcxx/include", "libcxx-final"]];
  const retained = roots.find(([root]) => path === root || path.startsWith(`${root}/`));
  if (retained) return { category: retained[1], retain: true };
  if (/^(configure\.log|icu\/(host|wasm)-(configure|make|build)\.log|libcxx\/(configure|make|build)\.log)$/.test(path)) return { category: "producer-logs", retain: false };
  return { category: "receipts-and-other", retain: true };
}

function walk(root: string, path: string, profile: Profile, inventory: Inventory, excludedAncestor = false): void {
  const absolute = join(root, path);
  const stat = lstatSync(absolute);
  const selected = category(path, profile);
  const count = inventory.bytes.get(selected.category) ?? { retained_regular_file_bytes: 0, excluded_regular_file_bytes: 0 };
  inventory.bytes.set(selected.category, count);
  if (stat.isFile()) count[selected.retain ? "retained_regular_file_bytes" : "excluded_regular_file_bytes"] += stat.size;
  if (!selected.retain && !excludedAncestor) inventory.excluded.push(path);
  const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
  if (!stat.isFile() && kind === "file") throw new Error(`Unsupported JSC artifact member: ${path}`);
  if (selected.retain) inventory.entries.set(path, { path, kind });
  if (kind !== "directory") return;
  for (const name of readdirSync(absolute).sort()) walk(root, join(path, name), profile, inventory, excludedAncestor || !selected.retain);
}

function excludedPath(path: string, options: Options, inventory: Inventory): boolean {
  return within(options.root, path) && inventory.excluded.some(excluded => within(join(options.root, excluded), path));
}

// Inspect each link hop as well as the final target, so an excluded intermediate link fails too.
function dependency(input: string, options: Options, inventory: Inventory, ancestors: readonly string[] = []): string {
  if (excludedPath(input, options, inventory)) throw new Error(`JSC dependency uses an excluded tree: ${input}`);
  if (ancestors.includes(input)) throw new Error(`Cyclic JSC artifact symlink: ${input}`);
  const parent = dirname(input);
  const physicalParent = parent === input ? input : dependencyParent(parent, options, inventory, ancestors);
  const path = join(physicalParent, basename(input));
  if (excludedPath(path, options, inventory)) throw new Error(`JSC dependency uses an excluded tree: ${path}`);
  const stat = lstatSync(path);
  checkRetainedPath(path, options, inventory);
  if (!stat.isSymbolicLink()) return path;
  return dependency(resolve(dirname(path), readlinkSync(path)), options, inventory, ancestors.concat([input]));
}

function dependencyParent(path: string, options: Options, inventory: Inventory, ancestors: readonly string[]): string {
  // realpath is cheap for the common parent with no symlink. Only expand links when it differs.
  const physical = realpathSync(path);
  if (physical === path) return path;
  return dependency(path, options, inventory, ancestors);
}

function checkRetainedPath(path: string, options: Options, inventory: Inventory): void {
  if (within(options.root, path)) {
    if (!inventory.entries.has(relative(options.root, path))) throw new Error(`Missing retained JSC dependency: ${path}`);
    return;
  }
  if (![options.sdk, options.sysroot].some(root => within(root, path) || within(realpathSync(root), path))) throw new Error(`JSC dependency escapes transferred prebuild and installed SDK/sysroot: ${path}`);
}

function retainedDependency(input: string, options: Options, inventory: Inventory): void {
  dependency(input, options, inventory);
}

function checkDirectoryClosure(path: string, options: Options, inventory: Inventory): void {
  if (inventory.excluded.some(excluded => within(path, join(options.root, excluded)))) throw new Error(`JSC dependency root contains excluded inputs: ${path}`);
}

function required(path: string, kind: "file" | "directory", options: Options, inventory: Inventory): void {
  retainedDependency(join(options.root, path), options, inventory);
  const stat = statSync(join(options.root, path));
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Invalid required JSC ${kind}: ${path}`);
}

function checkRequired(options: Options, inventory: Inventory): void {
  const profile = options.profile === "split" ? ["jsc.wasm"] : ["libcxx/lib/libc++.a", "libcxx/lib/libc++abi.a", "libcxx/include/__config_site", "libcxx/.bunwasm-inputs", "libcxx/.bunwasm-archives"];
  for (const path of artifacts.concat(inputs, profile, yarr.map(name => `webkit/Source/JavaScriptCore/yarr/${name}`))) required(path, "file", options, inventory);
  for (const path of ["icu/prefix/include", "webkit/.git/objects"]) required(path, "directory", options, inventory);
  const cache = readFileSync(join(options.root, "build/jsc/CMakeCache.txt"), "utf8");
  const version = ["MAJOR", "MINOR", "PATCH"].map(part => {
    const value = new RegExp(`^CMAKE_CACHE_${part}_VERSION:INTERNAL=(\\d+)$`, "m").exec(cache)?.[1];
    if (!value) throw new Error(`Missing JSC CMake cache ${part} version`);
    return value;
  }).join(".");
  for (const name of ["CMakeCCompiler.cmake", "CMakeCXXCompiler.cmake", "CMakeSystem.cmake"]) required(`build/jsc/CMakeFiles/${version}/${name}`, "file", options, inventory);
  required("build/jsc/CMakeFiles/rules.ninja", "file", options, inventory);
  const stamp = readFileSync(join(options.root, ".bunwasm-artifacts"), "utf8").trim().split("\n");
  for (const line of stamp) {
    const path = /^[a-f0-9]{64} [ *](.+)$/.exec(line)?.[1];
    if (!path || !isAbsolute(path) || !within(options.root, path)) throw new Error(`Invalid JSC artifact stamp member: ${line}`);
    required(relative(options.root, path), "file", options, inventory);
  }
}

function checkHeader(input: string, search: boolean, options: Options, inventory: Inventory): void {
  if (excludedPath(input, options, inventory)) throw new Error(`JSC include uses an excluded tree: ${input}`);
  try { retainedDependency(input, options, inventory); }
  catch (error) {
    if (!search || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    // CMake may emit absent search directories. Keep them absent, including through symlink parents.
    let parent = dirname(input);
    while (!lstatSync(parent, { throwIfNoEntry: false })) parent = dirname(parent);
    retainedDependency(parent, options, inventory);
    return;
  }
  const stat = statSync(input);
  if (!stat.isFile() && !(search && stat.isDirectory())) throw new Error(`Invalid JSC compiler input: ${input}`);
  if (search && stat.isDirectory()) checkDirectoryClosure(realpathSync(input), options, inventory);
}

function checkHeaders(options: Options, inventory: Inventory): void {
  const database: unknown = JSON.parse(readFileSync(join(options.root, "build/jsc/compile_commands.json"), "utf8"));
  if (!Array.isArray(database)) throw new Error("Invalid JSC compilation database");
  const entry: unknown = database.find(row => row && typeof row === "object" && "file" in row && typeof row.file === "string" && row.file.endsWith("/Source/JavaScriptCore/jsc.cpp"));
  if (!entry || typeof entry !== "object" || !("command" in entry) || typeof entry.command !== "string" || !("directory" in entry) || typeof entry.directory !== "string") throw new Error("Missing JSC helper compilation profile");
  // Match the consumer's whitespace tokenization; do not reinterpret shell quotes differently.
  const words = entry.command.split(/\s+/);
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    const separate = ["-I", "-isystem", "-iquote", "-include"].includes(word);
    const joined = ["-isystem", "-iquote", "-I"].find(flag => word.startsWith(flag) && word !== flag);
    const path = separate ? words[++index] : joined ? word.slice(joined.length) : undefined;
    if (!path && separate) throw new Error(`Missing JSC compiler input for ${word}`);
    if (path) checkHeader(resolve(entry.directory, path), word !== "-include", options, inventory);
  }
}

export function jscArtifactInventory(options: Options): Inventory {
  if (!isAbsolute(options.root) || realpathSync(options.root) !== options.root) throw new Error("JSC artifact root must be an absolute physical directory");
  const inventory: Inventory = { entries: new Map(), excluded: [], bytes: new Map() };
  walk(options.root, "", options.profile, inventory);
  checkRequired(options, inventory);
  checkHeaders(options, inventory);
  for (const entry of inventory.entries.values()) {
    if (entry.kind !== "symlink") continue;
    const path = join(options.root, entry.path);
    retainedDependency(path, options, inventory);
    if (statSync(path).isDirectory()) checkDirectoryClosure(realpathSync(path), options, inventory);
  }
  return inventory;
}

export function packJscArtifact(options: Options, output: string): void {
  const inventory = jscArtifactInventory(options);
  for (const [category, bytes] of inventory.bytes) console.log(JSON.stringify({ jsc_artifact_category: category, ...bytes }));
  const members = Array.from(inventory.entries.keys(), path => join(basename(options.root), path)).join("\0") + "\0";
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", 'tar --posix --no-recursion --null --verbatim-files-from -C "$1" -cf - -T - | zstd -T0 -q -o "$2"', "jsc-artifact", dirname(options.root), output], { input: members, stdio: ["pipe", "inherit", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`JSC artifact archiver failed: ${result.status ?? result.signal}`);
  console.log(JSON.stringify({ jsc_artifact_compressed_bytes: statSync(output).size }));
}

if (import.meta.main) {
  const [root, profile, output] = process.argv.slice(2);
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!root || !output || !sdk || !sysroot || (profile !== "split" && profile !== "shared-group")) throw new Error("Usage: source env.sh; bun scripts/ci-jsc-artifact.ts ROOT split|shared-group OUTPUT");
  packJscArtifact({ root, profile, sdk, sysroot }, output);
}
