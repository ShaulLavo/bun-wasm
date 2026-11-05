import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ProcessOwner } from "../process-owner.mts";
import { DONOR_NAMES, TOOL_NAMES, type DonorName, type ToolName } from "./contract.ts";
import { fileIdentity, inside } from "./identity.ts";
import { AdmissionError, cleanSource, donorDestination, receiptTools, requireStagedDonor, stagedSelection, type Authenticated } from "./inputs.ts";
import { runOwned } from "./process.ts";

function fail(message: string): never { throw new AdmissionError(message); }

/** Shell bookkeeping that differs between shells; nothing else is ignored when comparing environments. */
const SHELL_BOOKKEEPING = ["_", "SHLVL", "PWD", "OLDPWD"];
const AMBIENT = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"];
const SOURCE_ENV = "set -euo pipefail\nsource ./env.sh\nenv -0\n";
const SOURCE_TWICE = "set -euo pipefail\nsource ./env.sh\nsource ./env.sh\nenv -0\n";
const SOURCE_NATIVE = "set -euo pipefail\nsource jsc/common.sh\nsource ./env.sh\nenv -0\n";

/** Paths owned by one admission. Product destinations are created only after being registered here. */
export class Staging {
  readonly staged: string[] = [];
  constructor(readonly sourceRoot: string, readonly privateRoot: string) {}
  register(path: string): void {
    if (lstatSync(path, { throwIfNoEntry: false })) fail(`staging destination already exists: ${path}`);
    this.staged.push(path);
  }
}

function rebaseLinks(source: string, target: string, directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) rebaseLinks(source, target, path);
    if (entry.isSymbolicLink()) rebaseLink(source, target, path);
  }
}
function rebaseLink(source: string, target: string, path: string): void {
  const link = readlinkSync(path);
  if (!isAbsolute(link)) return;
  if (!inside(source, link)) fail(`staged link leaves its donor: ${path}`);
  unlinkSync(path);
  symlinkSync(relative(dirname(path), join(target, relative(source, link))), path);
}
/** Reflinked private copies (never hard links) of every donor, each checked against its donor identity. */
export async function stageDonors(authenticated: Authenticated, staging: Staging, owner: ProcessOwner, signal: AbortSignal): Promise<void> {
  const { manifest, config } = authenticated.run;
  for (const name of DONOR_NAMES) {
    const donor = manifest.donors[name];
    const target = donorDestination(name, staging.sourceRoot, staging.privateRoot);
    staging.register(target);
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(target);
    const selection = stagedSelection(name, config.sourceRoot);
    const args = selection ? ["-a", "--parents", "--reflink=auto", "--"].concat(selection, [target]) : ["-a", "--reflink=auto", "--", `${donor.path}/.`, `${target}/`];
    await runOwned(owner, { argv: ["/usr/bin/cp"].concat(args), cwd: donor.path, env: { PATH: "/usr/bin:/bin" } }, signal);
    rebaseLinks(donor.path, target, target);
    requireStagedDonor(name as DonorName, donor, target, config.sourceRoot);
  }
}

/** Allowlisted base: pinned tool directories, the receipt's canonical CMake/Ninja, private copies and native inputs. */
export function baseEnvironment(authenticated: Authenticated, staging: Staging, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const { manifest, config } = authenticated.run;
  const root = staging.privateRoot;
  const ambient = Object.fromEntries(AMBIENT.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key] as string]]));
  const canonical = receiptTools(manifest.native.sysroot.root);
  const tools = (["bun", "node", "git", "bash", "cc", "c++"] as const).map(name => dirname(manifest.tools[name].path));
  const path = Array.from(new Set([dirname(canonical.cmake), dirname(canonical.ninja)].concat(tools, ["/usr/bin", "/bin"]))).join(":");
  const jobs = String(config.jobs);
  return { ...ambient, PATH: path, BUN_EXE: manifest.tools.bun.path, NODE_EXE: manifest.tools.node.path,
    RUSTUP_HOME: donorDestination("rustup", config.sourceRoot, root), CARGO_HOME: donorDestination("cargo", config.sourceRoot, root),
    WASM_TOOLS: donorDestination("tools", config.sourceRoot, root), BUN_INSTALL_CACHE_DIR: donorDestination("bunCache", config.sourceRoot, root),
    WASI_SDK_PATH: manifest.native.sdk.root, BUN_WASM_SYSROOT: manifest.native.sysroot.root, JSC_BUILD_DIR: manifest.native.jsc.root,
    BASH_WEB_GUESTS_DIR: manifest.native.shell.root, BASH_WEB_GUESTS: "required", PLAYWRIGHT_BROWSERS_PATH: manifest.consumers.browsers.path,
    BUN_WASM_CACHE_DIR: join(root, "wasmtime-cache"), CARGO_TARGET_DIR: join(root, "targets"), TMPDIR: join(root, "t"), TMP: join(root, "t"), TEMP: join(root, "t"),
    CARGO_NET_OFFLINE: "true", WAFFLE_NETWORK_PREBUILT: "1", CARGO_BUILD_JOBS: jobs, JOBS: jobs, CAGE: "", ...extra };
}

async function sourced(script: string, env: Readonly<Record<string, string>>, staging: Staging, owner: ProcessOwner, signal: AbortSignal, name: string): Promise<Record<string, string>> {
  const log = join(staging.privateRoot, "admission", `${name}.env`);
  mkdirSync(dirname(log), { recursive: true });
  const output = openSync(log, "wx", 0o600);
  try { await runOwned(owner, { argv: ["/usr/bin/bash", "-c", script], cwd: staging.sourceRoot, env, output }, signal); }
  finally { closeSync(output); }
  return Object.fromEntries(readFileSync(log, "utf8").split("\0").filter(Boolean).map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
}
function pathList(value: string | undefined): string[] { return Array.from(new Set((value ?? "").split(":").filter(Boolean))); }
/** Differences that matter: every variable except declared shell bookkeeping, PATH compared without repeated prefixes. */
export function environmentDifferences(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): string[] {
  const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter(key => !SHELL_BOOKKEEPING.includes(key)).sort();
  return keys.flatMap(key => {
    if (key === "PATH") return pathList(a.PATH).join(":") === pathList(b.PATH).join(":") ? [] : ["PATH"];
    return a[key] === b[key] ? [] : [key];
  });
}
function stable(name: string, first: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): void {
  const differences = environmentDifferences(first, next);
  if (differences.length) fail(`${name} changes the sourced environment: ${differences.join(", ")}`);
}

export interface ProductEnvironment {
  /** The one sourced environment, with shell bookkeeping removed. Every capture and command starts from it. */
  readonly env: Readonly<Record<string, string>>;
  readonly tools: Readonly<Record<ToolName, string>>;
}
function which(env: Readonly<Record<string, string>>, name: string): string {
  for (const directory of pathList(env.PATH)) {
    const path = join(directory, name);
    if (existsSync(path) && lstatSync(realpathSync(path)).isFile()) return realpathSync(path);
  }
  fail(`sourced environment has no ${name}`);
}
function rustTool(env: Readonly<Record<string, string>>, name: string): string {
  const rustup = env.RUSTUP_HOME ?? fail("RUSTUP_HOME unset");
  const toolchains = join(rustup, "toolchains");
  const installed = existsSync(toolchains) ? readdirSync(toolchains) : [];
  if (installed.length !== 1) fail(`private Rust home must hold exactly one toolchain, found ${installed.length}`);
  const path = name === "rust-lld" ? findLld(join(toolchains, installed[0] ?? "")) : join(toolchains, installed[0] ?? "", "bin", name);
  return realpathSync(path);
}
function findLld(toolchain: string): string {
  const hosts = readdirSync(join(toolchain, "lib/rustlib")).filter(host => existsSync(join(toolchain, "lib/rustlib", host, "bin/rust-lld")));
  if (hosts.length !== 1) fail("private Rust toolchain must hold exactly one host rust-lld");
  return join(toolchain, "lib/rustlib", hosts[0] ?? "", "bin/rust-lld");
}
/**
 * env.sh prepends $WASM_TOOLS/cmake/bin and $WASM_TOOLS/ninja on every
 * sourcing. A staged copy there would shadow the canonical tools the original
 * sysroot receipt pins, and the builder would refuse that receipt.
 */
export function requireCanonicalBuildTools(env: Readonly<Record<string, string>>, sysroot: string): void {
  const canonical = receiptTools(sysroot);
  if (which(env, "cmake") !== realpathSync(canonical.cmake) || which(env, "ninja") !== realpathSync(canonical.ninja)) fail("sourced CMake or Ninja is not the sysroot receipt's canonical tool");
}
/** Each pinned tool resolves, in the sourced environment, to its exact bytes and its required owner. */
function resolveTools(authenticated: Authenticated, env: Readonly<Record<string, string>>): Record<ToolName, string> {
  const { manifest } = authenticated.run;
  const rust = new Set(["cargo", "rustc", "rust-lld"]);
  const tools = Object.fromEntries(TOOL_NAMES.map(name => [name, rust.has(name) ? rustTool(env, name) : which(env, name)])) as Record<ToolName, string>;
  for (const name of TOOL_NAMES) {
    const actual = fileIdentity(tools[name]);
    if (actual.sha256 !== manifest.tools[name].sha256 || actual.bytes !== manifest.tools[name].bytes) fail(`sourced ${name} is not the pinned tool: ${tools[name]}`);
  }
  requireCanonicalBuildTools(env, manifest.native.sysroot.root);
  for (const name of ["wasm-opt", "wasm-tools", "wasmtime"] as const) if (!inside(realpathSync(env.WASM_TOOLS ?? "/"), tools[name])) fail(`sourced ${name} is not the private staged copy`);
  for (const name of ["clang", "clang++", "llvm-ar", "wasm-ld"] as const) if (tools[name] !== realpathSync(join(manifest.native.sdk.root, "bin", name))) fail(`sourced ${name} is not the native SDK tool`);
  if (!env.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS?.includes(`-L native=${manifest.native.sysroot.root}/lib/wasm32-wasip1`)) fail("sourced guest Rust flags do not link the native sysroot");
  return tools;
}

/** The product's own sysroot input function, evaluated in E against the staged Waffle inputs. No downloader runs. */
export const SYSROOT_PROBE = `
import { join } from "node:path";
const root = process.cwd();
const { wasiSysrootInputs } = await import(join(root, "scripts/build-wasi-sysroot.ts"));
const { waffleNativeDirectory } = await import(join(root, "scripts/waffle-release-inputs.ts"));
const waffle = waffleNativeDirectory();
if (!(await Bun.file(join(waffle, "scripts/build-wasi-libc.sh")).exists())) throw new Error("staged Waffle native inputs are missing: " + waffle);
const inputs = await wasiSysrootInputs({ waffle, sdk: process.env.WASI_SDK_PATH });
const libc = join(process.env.BUN_WASM_SYSROOT, "lib/wasm32-wasip1/libc.a");
console.log(JSON.stringify({ ...inputs, libcSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(libc).arrayBuffer()).digest("hex") }));
`;
async function probe(argv: readonly string[], env: Readonly<Record<string, string>>, staging: Staging, owner: ProcessOwner, signal: AbortSignal, name: string): Promise<string> {
  const log = join(staging.privateRoot, "admission", `${name}.out`);
  mkdirSync(dirname(log), { recursive: true });
  const output = openSync(log, "wx", 0o600);
  try { await runOwned(owner, { argv, cwd: staging.sourceRoot, env, output }, signal); }
  catch (error) { fail(`${name} failed in the sourced environment: ${error instanceof Error ? error.message : String(error)}\n${readFileSync(log, "utf8").slice(-2000)}`); }
  finally { closeSync(output); }
  return readFileSync(log, "utf8").trim();
}
/**
 * The maintained native entry every production native stage runs: JSC stamp,
 * archive list, the (private, read-only) WebKit patch check, the configured
 * CMake cache, then the sysroot builder's verification branch.
 */
export const NATIVE_ENTRY = "set -euo pipefail\nsource jsc/common.sh\ncheck_jsc_inputs_stamp\n\"$BUN_EXE\" scripts/build-wasi-sysroot.ts\n";
const JSC_ENTRY = "set -euo pipefail\nsource jsc/common.sh\ncheck_jsc_inputs_stamp\n";
/** Metadata of the native backing an admission must leave untouched. */
export function nativeWitness(roots: readonly string[]): string {
  const paths = roots.flatMap(root => [root, join(root, "build/jsc/.bunwasm-inputs"), join(root, "webkit/.git"), join(root, "webkit/.git/index"), join(root, "webkit/.git/objects")]);
  return paths.filter(path => existsSync(path)).map(path => {
    const stat = lstatSync(path, { bigint: true });
    return `${path}\0${stat.ino}\0${stat.size}\0${stat.mode}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
  }).join("\n");
}
/**
 * Every Waffle native input the sysroot builder resolves must already be staged
 * with its pinned digest: with all of them present its downloader is unreachable.
 */
export function requireStagedWaffle(env: Readonly<Record<string, string>>, sourceRoot: string): void {
  const pin = JSON.parse(readFileSync(join(sourceRoot, "scripts/waffle-release-inputs.json"), "utf8")) as { sourceCommit: string; packagePath: string; sha256: string; files: Record<string, string> };
  const directory = join(env.WASM_TOOLS ?? fail("WASM_TOOLS unset"), "waffle-native", pin.sourceCommit, pin.packagePath);
  const pinned = Object.entries(pin.files).map(([path, digest]) => [join(directory, path), digest] as const).concat([[join(dirname(directory), "runtime.tgz"), pin.sha256]]);
  for (const [path, digest] of pinned) {
    if (!existsSync(path) || fileIdentity(path).sha256 !== digest) fail(`staged Waffle native input is missing or differs: ${path}`);
  }
}
/**
 * Complete native admission before any durable claim: sysroot receipt equality
 * field by field, then the maintained native entry itself, which must take the
 * original receipt's verification branch, refuse a wrong JSC stamp, and leave
 * the original backing's metadata untouched.
 */
export async function requireNativeEntry(sourceRoot: string, roots: { readonly jsc: string; readonly sysroot: string }, env: Readonly<Record<string, string>>, staging: Staging, owner: ProcessOwner, signal: AbortSignal): Promise<void> {
  if (!existsSync(roots.jsc)) fail(`JSC root is missing: ${roots.jsc}`);
  const before = nativeWitness([roots.jsc, roots.sysroot]);
  // The JSC half first: a wrong stamp, archive list, WebKit tree or CMake cache refuses before anything else runs.
  await probe(["/usr/bin/bash", "-c", JSC_ENTRY], env, staging, owner, signal, "jsc-entry");
  if (nativeWitness([roots.jsc, roots.sysroot]) !== before) fail("JSC admission changed original native backing metadata");
  requireStagedWaffle(env, sourceRoot);
  const sysroot = JSON.parse(await probe([env.BUN_EXE ?? "bun", "-e", SYSROOT_PROBE], env, staging, owner, signal, "sysroot-inputs")) as unknown;
  const original: unknown = JSON.parse(readFileSync(join(roots.sysroot, "bun-wasm-sysroot.json"), "utf8"));
  if (JSON.stringify(sysroot) !== JSON.stringify(original)) fail("original sysroot receipt differs from the sourced selected-source inputs");
  const output = await probe(["/usr/bin/bash", "-c", NATIVE_ENTRY], env, staging, owner, signal, "native-entry");
  if (!output.includes(`Patched Bun sysroot verified: ${roots.sysroot}`)) fail("native entry did not take the original sysroot verification branch");
  if (nativeWitness([roots.jsc, roots.sysroot]) !== before) fail("native admission changed original native backing metadata");
}
/** Every crate the locks name is already in the private Cargo home; nothing is downloaded. */
async function offlineCargo(env: Readonly<Record<string, string>>, tools: Readonly<Record<ToolName, string>>, staging: Staging, owner: ProcessOwner, signal: AbortSignal): Promise<void> {
  await probe([tools.cargo, "fetch", "--locked", "--offline"], env, staging, owner, signal, "cargo-fetch");
  const library = join(dirname(dirname(tools.rustc)), "lib/rustlib/src/rust/library/Cargo.toml");
  if (!existsSync(library)) fail("private Rust toolchain lacks build-std library sources");
  await probe([tools.cargo, "fetch", "--locked", "--offline", "--manifest-path", library], env, staging, owner, signal, "cargo-fetch-build-std");
}

/**
 * Establish E: source the selected env.sh once over the allowlisted base,
 * then prove that sourcing it again, and through jsc/common.sh, changes no
 * semantic value. Then check tools, native receipts and offline crates in E.
 */
export async function establishEnvironment(authenticated: Authenticated, staging: Staging, base: Readonly<Record<string, string>>, owner: ProcessOwner, signal: AbortSignal): Promise<ProductEnvironment> {
  const first = await sourced(SOURCE_ENV, base, staging, owner, signal, "source-1");
  const env = Object.fromEntries(Object.entries(first).filter(([key]) => !SHELL_BOOKKEEPING.includes(key)));
  stable("re-sourcing env.sh", env, await sourced(SOURCE_TWICE, env, staging, owner, signal, "source-2"));
  stable("sourcing jsc/common.sh", env, await sourced(SOURCE_NATIVE, env, staging, owner, signal, "source-native"));
  const tools = resolveTools(authenticated, env);
  const { native, config } = { native: authenticated.run.manifest.native, config: authenticated.run.config };
  if (native.sysroot.provenance.status === "verified" && native.jsc.provenance.status === "verified") {
    await requireNativeEntry(config.sourceRoot, { jsc: native.jsc.root, sysroot: native.sysroot.root }, env, staging, owner, signal);
    // The original header manifest's native groups must equal this source's JSC inputs, before any claim.
    await probe([env.BUN_EXE ?? "bun", "scripts/c1/native-header.ts", config.manifest.path], env, staging, owner, signal, "native-header");
  }
  await offlineCargo(env, tools, staging, owner, signal);
  cleanSource(authenticated.run.config.sourceRoot);
  return { env, tools };
}
