import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, lstatSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { verifySplitSysroot } from "./src/program-profile.ts";

const tlsPin = "41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f";
export const tlsWasiFlags = "-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK";
const tlsSourcePaths = ["CMakeLists.txt", "cmake", "include", "crypto", "ssl", "gen", "third_party", "util", "decrepit/cfb/cfb.cc", "decrepit/blowfish/blowfish.cc", "decrepit/macros.h"];
const tlsRepositoryPaths = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "env.sh", "crates/bunwasm-crypto-sys", "jsc/wasi-jsc.cmake", "scripts/check-cmake-cache.cmake", "tests/native/tls-probe.cpp", "scripts/quality-command.ts", "scripts/quality-rust.ts", "scripts/quality-wasi.ts", "scripts/src/program-profile.ts"];

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function fileIdentity(path: string) {
  assert.ok(lstatSync(path).isFile(), `TLS evidence is not a regular file: ${path}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { path, sha256: hash.digest("hex"), bytes };
}
export function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}
async function treeFiles(root: string, path: string, allowed: readonly string[], ancestors: readonly string[] = []): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const physical = realpathSync(join(root, path));
  assert.ok(allowed.some(parent => contained(parent, physical)), `TLS input escapes root: ${path}`);
  if (lstatSync(physical).isFile()) return [{ ...await fileIdentity(physical), path }];
  assert.ok(!ancestors.includes(physical), "Cyclic TLS source input");
  assert.ok(lstatSync(physical).isDirectory(), `TLS input is not a directory: ${path}`);
  let files: { path: string; sha256: string; bytes: number }[] = [];
  for (const name of readdirSync(physical).filter(name => name !== ".git").sort()) files = files.concat(await treeFiles(root, join(path, name), allowed, ancestors.concat([physical])));
  return files;
}
export async function treeIdentity(root: string, paths: readonly string[], allowed: readonly string[] = [realpathSync(root)]) {
  let files: { path: string; sha256: string; bytes: number }[] = [];
  for (const path of paths) files = files.concat(await treeFiles(root, path, allowed));
  return digest(JSON.stringify(files));
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  assert.ok(value && !/[\0\r\n]/.test(value), `Missing or unsafe ${name}`);
  return value;
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim();
}
export async function tlsContext(env: NodeJS.ProcessEnv = process.env) {
  const workspace = realpathSync(required(env, "GITHUB_WORKSPACE"));
  const target = realpathSync(required(env, "CARGO_TARGET_DIR"));
  const sdk = realpathSync(required(env, "WASI_SDK_PATH"));
  const sysroot = realpathSync(required(env, "BUN_WASM_SYSROOT"));
  verifySplitSysroot(sysroot);
  const source = realpathSync(env.BUNWASM_BORINGSSL_SOURCE ?? join(workspace, "vendor/boringssl"));
  assert.equal(target, join(workspace, "target"), "TLS requires the native handoff target root");
  assert.equal(env.BUN_WASM_PROGRAM_PROFILE, undefined, "TLS probe is split only");
  for (const name of ["CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "SDKROOT", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]) assert.ok(!env[name], `TLS recording does not admit ambient ${name}`);
  assert.equal(git(workspace, "rev-parse", "HEAD"), required(env, "GITHUB_SHA"));
  assert.equal(git(workspace, "status", "--porcelain", "--untracked-files=no"), "", "TLS source must be clean");
  const attempt = required(env, "TLS_PRODUCER_ATTEMPT");
  assert.match(attempt, /^[1-9][0-9]*$/);
  const named = { clang: join(sdk, "bin/clang"), cxx: join(sdk, "bin/clang++"), ar: join(sdk, "bin/llvm-ar"), linker: join(sdk, "bin/wasm-ld"), cc: "/usr/bin/cc", hostCxx: "/usr/bin/c++", bun: process.execPath };
  const selected: Record<string, string> = { ...named };
  for (const tool of ["node", "wasmtime", "wasm-tools", "cmake", "ninja"]) {
    const path = Bun.which(tool, { PATH: env.PATH });
    assert.ok(path, `Missing TLS tool ${tool}`);
    selected[tool] = path;
  }
  const rustup = Bun.which("rustup", { PATH: env.PATH });
  assert.ok(rustup, "Missing Rustup tool resolver");
  for (const tool of ["cargo", "rustc"]) selected[tool] = execFileSync(rustup, ["which", tool], { env, encoding: "utf8" }).trim();
  const tools = Object.fromEntries(await Promise.all(Object.entries(selected).map(async ([name, path]): Promise<[string, Awaited<ReturnType<typeof fileIdentity>> & { executable: string }]> => [name, { ...await fileIdentity(realpathSync(path)), executable: path }])));
  return {
    schema: 1, run: required(env, "GITHUB_RUN_ID"), attempt, head: required(env, "GITHUB_SHA"), tree: git(workspace, "rev-parse", "HEAD^{tree}"),
    workspace, target, sdk, sysroot, source, profile: "split", pin: tlsPin,
    hostTools: required(env, "NATIVE_HOST_TOOLS_HASH"), nativeInputs: required(env, "NATIVE_INPUTS_HASH"),
    repository: await treeIdentity(workspace, tlsRepositoryPaths.concat(readdirSync(join(workspace, "scripts")).filter(name => /^tls-probe.*\.ts$/.test(name) && !/\.test\.ts$|tls-probe-fixture\.ts$/.test(name)).map(name => `scripts/${name}`), ["checks/native-probe-tls.json"])),
    upstream: await treeIdentity(source, tlsSourcePaths),
    sysrootInputs: await treeIdentity(sysroot, ["bun-wasm-sysroot.json", "include", "lib"], [sysroot, sdk]),
    sdkInputs: await treeIdentity(sdk, ["VERSION", "lib/clang"]), tools,
    nativeFlags: { c: env.CFLAGS ?? "", cxx: env.CXXFLAGS ?? "" },
  };
}
export type TlsContext = Awaited<ReturnType<typeof tlsContext>>;
export function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
export function checkedTool(context: TlsContext, name: string): string {
  const tool = context.tools[name];
  assert.ok(tool, `TLS tool is not recorded: ${name}`);
  return tool.executable;
}
