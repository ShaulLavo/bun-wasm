import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { atomicJson, fileIdentity, type TlsContext, tlsWasiFlags } from "./tls-probe-inputs.ts";
import { inspectCryptoOutput, type BuildScript } from "./tls-probe-cargo.ts";
import { linkTlsCheckpoint, prepareTlsRecording } from "./tls-probe-ci.ts";

export function syntheticObject(abi: "host" | "wasm32-wasip1") {
  if (abi === "wasm32-wasip1") return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const bytes = Buffer.alloc(64);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(1, 16);
  bytes.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
  return bytes;
}
export function syntheticArchive(bytes: Buffer): Buffer {
  const header = "fixture.o/".padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) + "100644".padEnd(8) + String(bytes.length).padEnd(10) + "`\n";
  return Buffer.concat([Buffer.from("!<arch>\n" + header), bytes, Buffer.alloc(bytes.length % 2, 10)]);
}
export function fixturePut(path: string, bytes: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}
export async function tlsFixture() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-tls-source-"));
  const target = join(root, "target");
  const source = join(root, "source");
  const sdk = join(root, "sdk");
  const sysroot = join(root, "sysroot");
  for (const path of [target, source, sdk, sysroot]) mkdirSync(path);
  const cargo = join(root, "fake-cargo.ts");
  fixturePut(cargo, `#!${process.execPath}\nimport { writeSync } from "node:fs";
if (process.env.FIXTURE_EXPECT_TOOLCHAIN && process.env.RUSTUP_TOOLCHAIN !== process.env.FIXTURE_EXPECT_TOOLCHAIN) throw new Error("Cargo lost the selected Rustup toolchain");
if (process.env.FIXTURE_EXPECT_RUSTC && process.env.RUSTC !== process.env.FIXTURE_EXPECT_RUSTC) throw new Error("Cargo lost the selected compiler");
const text = process.env.FIXTURE_MESSAGES ?? "";
for (const char of text) writeSync(1, char);
process.stderr.write("fixture stderr\\n");
if (process.env.FIXTURE_SIGNAL) process.kill(process.pid, "SIGTERM");
else process.exit(Number(process.env.FIXTURE_EXIT ?? "0"));\n`);
  chmodSync(cargo, 0o755);
  const tools: TlsContext["tools"] = {};
  for (const name of ["clang", "cxx", "cc", "hostCxx", "wasm-tools", "cargo", "rustc"]) {
    const path = name === "cargo" ? cargo : join(root, "tools", name);
    if (name !== "cargo") fixturePut(path, "synthetic tool bytes, never executed");
    tools[name] = { ...await fileIdentity(path), executable: path };
  }
  const context: TlsContext = {
    rustToolchain: "nightly-fixture-x86_64-unknown-linux-gnu", schema: 1, run: "77", attempt: "2", head: "a".repeat(40), tree: "b".repeat(40), workspace: root, target, source, sdk, sysroot,
    profile: "split", pin: "41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f", hostTools: "c".repeat(64), nativeInputs: "d".repeat(64),
    repository: "e".repeat(64), upstream: "f".repeat(64), sysrootInputs: "1".repeat(64), sdkInputs: "2".repeat(64), tools, nativeFlags: { c: "", cxx: "" },
  };
  return { root, context, cargo, remove: () => rmSync(root, { recursive: true, force: true }) };
}
export async function fixtureCrypto(context: TlsContext, abi: "host" | "wasm32-wasip1"): Promise<BuildScript> {
  const outDir = join(context.target, abi, "out");
  const directory = join(outDir, "boringssl");
  const wasi = abi === "wasm32-wasip1";
  const cc = context.tools[wasi ? "clang" : "cc"]!.path;
  const cxx = context.tools[wasi ? "cxx" : "hostCxx"]!.path;
  fixturePut(join(context.workspace, "jsc/wasi-jsc.cmake"), "synthetic toolchain input");
  const cache = { CMAKE_TOOLCHAIN_FILE: wasi ? join(context.workspace, "jsc/wasi-jsc.cmake") : "", CMAKE_HOME_DIRECTORY: context.source, CMAKE_BUILD_TYPE: "MinSizeRel", OPENSSL_NO_ASM: "1", BUILD_TESTING: "OFF", CMAKE_SYSROOT: wasi ? context.sysroot : "", CMAKE_C_COMPILER: cc, CMAKE_CXX_COMPILER: cxx, CMAKE_C_FLAGS: wasi ? tlsWasiFlags : "", CMAKE_CXX_FLAGS: wasi ? `${tlsWasiFlags} -fno-exceptions -fno-rtti` : "" };
  fixturePut(join(directory, "CMakeCache.txt"), Object.entries(cache).filter(([key]) => !wasi || !["CMAKE_C_COMPILER", "CMAKE_CXX_COMPILER"].includes(key)).map(([key, value]) => `${key}:STRING=${value}\n`).join(""));
  fixturePut(join(directory, "build.ninja"), "include CMakeFiles/rules.ninja\n");
  const target = wasi ? " --target=wasm32-wasip1" : "";
  const rules = [["C", cc], ["CXX", cxx]].map(([language, compiler]) =>
    `rule ${language}_COMPILER__crypto_unscanned_MinSizeRel\n  depfile = $DEP_FILE\n  deps = gcc\n  command = ${compiler}${target} $DEFINES $INCLUDES $FLAGS -MD -MT $out -MF $DEP_FILE -o $out -c $in\n  description = Building ${language} object $out\n`);
  fixturePut(join(directory, "CMakeFiles/rules.ninja"), rules.join("\n"));
  fixturePut(join(directory, "bunwasm-program-profile"), "split");
  fixturePut(join(directory, "CMakeFiles/4.4.4/CMakeSystem.cmake"), `set(CMAKE_SYSTEM_NAME "${wasi ? "WASI" : "Linux"}")\n`);
  for (const [language, compiler] of [["C", cc], ["CXX", cxx]]) fixturePut(join(directory, `CMakeFiles/4.4.4/CMake${language}Compiler.cmake`), `set(CMAKE_${language}_COMPILER "${compiler}")\n`);
  for (const lib of ["ssl", "crypto"]) fixturePut(join(directory, `lib${lib}.a`), syntheticArchive(syntheticObject(abi)));
  return { packageId: `path+${pathToFileURL(join(context.workspace, "crates/bunwasm-crypto-sys")).href}#0.0.0`, outDir, linkedPaths: [`native=${directory}`], linkedLibs: ["static=ssl", "static=crypto"] };
}
export function fixtureMessages(build: BuildScript): string {
  return JSON.stringify({ reason: "compiler-message", message: { rendered: "diagnostic λ\n" } }) + "\n" + JSON.stringify({ reason: "build-script-executed", package_id: build.packageId, out_dir: build.outDir, linked_paths: build.linkedPaths, linked_libs: build.linkedLibs, fresh: true }) + "\n" + JSON.stringify({ reason: "build-finished", success: true }) + "\n";
}
export async function fixtureHandoff(context: TlsContext, failSize = false) {
  const saved = { target: process.env.CARGO_TARGET_DIR, output: process.env.GITHUB_OUTPUT };
  process.env.CARGO_TARGET_DIR = context.target;
  process.env.GITHUB_OUTPUT = join(context.workspace, "job-output");
  const root = join(context.target, "tls-probe");
  const commands: string[] = [];
  try {
    await prepareTlsRecording(async () => context);
    for (const abi of ["host", "wasm32-wasip1"] as const) {
      const build = await fixtureCrypto(context, abi);
      const output = await inspectCryptoOutput(context, abi, build);
      const command = [context.tools.cargo!.path, abi === "host" ? "test" : "clippy", "--locked", "--message-format=json-render-diagnostics"].concat(abi === "host" ? [] : ["--target", abi]);
      atomicJson(join(root, "cargo", `${abi}.json`), { context, command, output });
    }
    const run = (executable: string, args: readonly string[]) => syntheticCommand(executable, args, context, commands, failSize);
    const authenticate = () => ({ url: `https://codeload.github.com/oven-sh/boringssl/tar.gz/${context.pin}`, archiveSha256: "8".repeat(64), fullDirectoryMatchesPinnedArchive: true });
    const sha256 = await linkTlsCheckpoint({ capture: async () => context, run, authenticate });
    return { root, sha256, commands, jobOutput: readFileSync(process.env.GITHUB_OUTPUT, "utf8") };
  } finally {
    if (saved.target === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = saved.target;
    if (saved.output === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = saved.output;
  }
}
function syntheticCommand(executable: string, args: readonly string[], context: TlsContext, commands: string[], failSize: boolean): string {
  commands.push(executable);
  const destination = args[args.indexOf("-o") + 1];
  if (args[0] === "objdump") return "synthetic sections";
  if (args[0] === "strip") {
    if (failSize) throw new Error("synthetic strip failure");
    if (!destination) throw new Error("Missing strip output");
    copyFileSync(args[1]!, destination);
    return "";
  }
  if (!destination) throw new Error("Missing synthetic link output");
  fixturePut(destination, syntheticObject(destination.endsWith(".wasm") ? "wasm32-wasip1" : "host"));
  const map = args.find(arg => arg.startsWith("-Wl,-Map="));
  if (map) fixturePut(map.slice("-Wl,-Map=".length), syntheticMap(context));
  return "";
}

function syntheticMap(context: TlsContext): string {
  for (const path of ["libc.a", "noeh/libc++.a"]) fixturePut(join(context.sysroot, "lib/wasm32-wasip1", path), syntheticArchive(syntheticObject("wasm32-wasip1")));
  return [`${context.sysroot}/lib/wasm32-wasip1/libc.a(malloc.o):(malloc)`, `${context.sysroot}/lib/wasm32-wasip1/noeh/libc++.a(string.o):(string)`, "/archives/libssl.a(client.o):(SSL_do_handshake)", "/archives/libssl.a(cert.o):(SSL_get_verify_result)", `${context.sysroot}/lib/wasm32-wasip1/libc.a(getentropy.c.obj):(__getentropy)`, `${context.sysroot}/lib/wasm32-wasip1/libc.a(__wasilibc_real.c.obj):(__wasi_random_get)`].join("\n");
}
