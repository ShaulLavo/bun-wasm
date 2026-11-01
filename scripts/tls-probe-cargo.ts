import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { inspectArchive, type TlsAbi } from "./tls-probe-archives.ts";
import { atomicJson, checkedTool, contained, fileIdentity, object, tlsContext, type TlsContext } from "./tls-probe-inputs.ts";

export type BuildScript = { packageId: string; outDir: string; linkedPaths: string[]; linkedLibs: string[] };
export class CargoTlsMessages {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private build: BuildScript | undefined;
  private finished = false;
  failure: unknown;
  private readonly packagePrefix: string;
  private readonly output: (text: string) => void;
  constructor(packagePrefix: string, output: (text: string) => void) { this.packagePrefix = packagePrefix; this.output = output; }
  feed(chunk: Uint8Array): void {
    this.pending += this.decoder.write(Buffer.from(chunk));
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      this.consume(line);
    }
    if (this.pending.length > 8 * 1024 * 1024) {
      this.failure = new Error("Cargo JSON line exceeds 8 MiB; no TLS record saved");
      this.output(this.pending);
      this.pending = "";
    }
  }
  end(): BuildScript {
    this.pending += this.decoder.end();
    if (this.pending) this.consume(this.pending);
    if (this.failure) throw this.failure;
    assert.ok(this.finished && this.build, "Cargo did not finish with exact crypto build-script output");
    return this.build;
  }
  private consume(line: string): void {
    try { this.message(line); }
    catch (error) { this.failure ??= error; this.output(line + "\n"); }
  }
  private message(line: string): void {
    if (this.finished || !line.startsWith("{")) { this.output(line + "\n"); return; }
    const value: unknown = JSON.parse(line);
    assert.ok(object(value), "Malformed Cargo message");
    if (value.reason === "compiler-message" && object(value.message) && typeof value.message.rendered === "string") this.output(value.message.rendered);
    if (value.reason === "build-finished") { assert.equal(this.finished, false, "Duplicate Cargo completion"); assert.equal(value.success, true, "Cargo build-finished failed"); this.finished = true; }
    if (!["compiler-message", "compiler-artifact", "build-script-executed", "build-finished"].includes(String(value.reason))) this.output(line + "\n");
    if (value.reason !== "build-script-executed" || typeof value.package_id !== "string" || !value.package_id.startsWith(this.packagePrefix)) return;
    assert.ok(typeof value.out_dir === "string" && Array.isArray(value.linked_paths) && Array.isArray(value.linked_libs), "Incomplete Cargo crypto event");
    assert.ok(value.linked_paths.every(path => typeof path === "string") && value.linked_libs.every(lib => typeof lib === "string"));
    const build = { packageId: value.package_id, outDir: value.out_dir, linkedPaths: value.linked_paths, linkedLibs: value.linked_libs };
    if (this.build) assert.deepEqual(build, this.build, "Conflicting Cargo crypto outputs");
    this.build = build;
  }
}
function cacheValues(text: string): Map<string, string> {
  return new Map(Array.from(text.matchAll(/^([^#\n/:]+):[^=\n]+=([^\n]*)$/gm), match => [match[1]!, match[2]!]));
}
function inspectNinjaTarget(directory: string, abi: TlsAbi): void {
  const source = readFileSync(join(directory, "CMakeFiles/rules.ninja"), "utf8");
  const rules = Array.from(source.matchAll(/^rule (?:C|CXX)_COMPILER__[^\n]*\n((?:[ \t]+[^\n]*\n)+)/gm));
  assert.ok(rules.length > 0, "Ninja compiler rules are missing");
  const expected = abi === "wasm32-wasip1" ? ["--target=wasm32-wasip1"] : [];
  for (const rule of rules) {
    const command = /^[ \t]+command[ \t]*=[ \t]*([^\n]+)$/m.exec(rule[1] ?? "")?.[1];
    assert.ok(command, "Ninja compiler command is missing");
    const targets = Array.from(new Set(command.match(/--target=[^ \r\n]+/g) ?? []));
    assert.deepEqual(targets, expected, "Ninja compiler target differs from invocation");
  }
}

export async function inspectCryptoOutput(context: TlsContext, abi: TlsAbi, build: BuildScript) {
  const outDir = realpathSync(build.outDir);
  assert.ok(contained(context.target, outDir), "Cargo out_dir escapes private target");
  const directory = join(outDir, "boringssl");
  assert.ok(build.linkedPaths.includes(`native=${directory}`), "Cargo did not link its exact BoringSSL output");
  for (const name of ["static=ssl", "static=crypto"]) assert.ok(build.linkedLibs.includes(name), `Cargo omitted ${name}`);
  const cache = cacheValues(readFileSync(join(directory, "CMakeCache.txt"), "utf8"));
  assert.equal(realpathSync(cache.get("CMAKE_HOME_DIRECTORY") ?? ""), context.source, "foreign CMake source");
  assert.equal(cache.get("CMAKE_BUILD_TYPE"), "MinSizeRel");
  assert.equal(cache.get("OPENSSL_NO_ASM"), "1");
  assert.equal(cache.get("BUILD_TESTING"), "OFF");
  assert.equal(readFileSync(join(directory, "bunwasm-program-profile"), "utf8"), "split");
  const wasi = abi === "wasm32-wasip1";
  assert.equal(cache.get("CMAKE_SYSROOT") ?? "", wasi ? context.sysroot : "");
  if (wasi) assert.equal(realpathSync(cache.get("CMAKE_TOOLCHAIN_FILE") ?? ""), realpathSync(join(context.workspace, "jsc/wasi-jsc.cmake")), "foreign WASI toolchain");
  else assert.ok(!cache.get("CMAKE_TOOLCHAIN_FILE"), "native output has a foreign toolchain");
  const c = context.tools[wasi ? "clang" : "cc"]?.path;
  const cxx = context.tools[wasi ? "cxx" : "hostCxx"]?.path;
  assert.ok(c && cxx, "Missing compiler identities");
  assert.equal(realpathSync(cache.get("CMAKE_C_COMPILER") ?? ""), c);
  assert.equal(realpathSync(cache.get("CMAKE_CXX_COMPILER") ?? ""), cxx);
  const metadata = readdirSync(join(directory, "CMakeFiles")).filter(name => /^\d+\.\d+(?:\.\d+)?$/.test(name));
  assert.equal(metadata.length, 1, "ambiguous CMake compiler metadata");
  const version = join(directory, "CMakeFiles", metadata[0]!);
  const system = readFileSync(join(version, "CMakeSystem.cmake"), "utf8");
  assert.ok(system.includes(`set(CMAKE_SYSTEM_NAME "${wasi ? "WASI" : "Linux"}")`), "CMake ABI differs from invocation");
  const files = ["CMakeCache.txt", "build.ninja", "CMakeFiles/rules.ninja", "bunwasm-program-profile"].map(path => join(directory, path)).concat([join(version, "CMakeSystem.cmake")]);
  for (const [language, compiler] of [["C", c], ["CXX", cxx]]) {
    const path = join(version, `CMake${language}Compiler.cmake`);
    const compilerInfo = readFileSync(path, "utf8");
    const selected = new RegExp(`set\\(CMAKE_${language}_COMPILER "([^"]+)"\\)`).exec(compilerInfo)?.[1];
    assert.ok(selected && realpathSync(selected) === compiler, "CMake compiler identity changed");
    files.push(path);
  }
  inspectNinjaTarget(directory, abi);
  const flags = "-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK";
  assert.equal(cache.get("CMAKE_C_FLAGS") ?? "", wasi ? flags : context.nativeFlags.c);
  assert.equal(cache.get("CMAKE_CXX_FLAGS") ?? "", wasi ? `${flags} -fno-exceptions -fno-rtti` : context.nativeFlags.cxx);
  const archives = { ssl: join(directory, "libssl.a"), crypto: join(directory, "libcrypto.a") };
  for (const path of Object.values(archives)) { inspectArchive(path, abi); files.push(path); }
  return { abi, build, archives, files: await Promise.all(files.map(fileIdentity)) };
}
export async function verifyCryptoRecord(path: string, context: TlsContext, abi: TlsAbi) {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(object(value) && object(value.output) && object(value.output.build), "Malformed TLS Cargo record");
  assert.deepEqual(value.context, context, "TLS Cargo context changed");
  assert.ok(Array.isArray(value.command) && value.command.every(word => typeof word === "string"), "Missing Cargo command identity");
  assert.equal(value.command[0], checkedTool(context, "cargo"));
  assert.ok(value.command.includes("--locked") && value.command.includes("--message-format=json-render-diagnostics"));
  assert.ok(abi === "host" ? value.command[1] === "test" && !value.command.includes("--target") : value.command[1] === "clippy" && value.command[value.command.indexOf("--target") + 1] === abi, "Foreign Cargo command ABI");
  const build = value.output.build;
  assert.ok(typeof build.packageId === "string" && typeof build.outDir === "string" && Array.isArray(build.linkedPaths) && Array.isArray(build.linkedLibs));
  assert.ok(build.linkedPaths.every(item => typeof item === "string") && build.linkedLibs.every(item => typeof item === "string"));
  assert.ok(build.packageId.startsWith(`path+${pathToFileURL(join(context.workspace, "crates/bunwasm-crypto-sys")).href}#`), "Foreign Cargo package source");
  const output = await inspectCryptoOutput(context, abi, { packageId: build.packageId, outDir: build.outDir, linkedPaths: build.linkedPaths, linkedLibs: build.linkedLibs });
  assert.deepEqual(value.output, output, "TLS Cargo archive or compiler proof changed");
  return output;
}
export async function recordCargo(command: readonly string[], abi: TlsAbi, env: NodeJS.ProcessEnv, captureContext = tlsContext): Promise<void> {
  const directory = env.BUNWASM_TLS_CARGO_RECORD_DIR;
  assert.ok(directory, "Missing private TLS Cargo recording directory");
  assert.ok(env.GITHUB_WORKSPACE, "Missing recording workspace");
  assert.equal(directory, join(realpathSync(env.GITHUB_WORKSPACE), "target/tls-probe/cargo"), "Foreign recording directory");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${abi}.json`);
  rmSync(path, { force: true });
  const before = await captureContext(env);
  assert.equal(directory, join(before.target, "tls-probe", "cargo"));
  const target = command.indexOf("--target");
  assert.ok(abi === "host" ? target === -1 && !env.CARGO_BUILD_TARGET : target >= 0 && command[target + 1] === abi, "Cargo command ABI mismatch");
  const messages = new CargoTlsMessages(`path+${pathToFileURL(join(before.workspace, "crates/bunwasm-crypto-sys")).href}#`, text => process.stdout.write(text));
  const separator = command.indexOf("--");
  const at = separator < 0 ? command.length : separator;
  const args = command.slice(1, at).concat(["--message-format=json-render-diagnostics"], command.slice(at));
  const producerEnv = { ...env, RUSTUP_TOOLCHAIN: before.rustToolchain, RUSTC: checkedTool(before, "rustc") };
  const child = spawn(checkedTool(before, "cargo"), args, { env: producerEnv, stdio: ["inherit", "pipe", "inherit"] });
  child.stdout.on("data", (chunk: Buffer) => messages.feed(chunk));
  const result = await new Promise<{ status: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  if (result.status !== 0) throw new Error(`${command[0]} failed: ${result.signal ?? result.status}`);
  const build = messages.end();
  const output = await inspectCryptoOutput(before, abi, build);
  assert.deepEqual(await captureContext(env), before, "TLS inputs changed during Cargo producer");
  atomicJson(path, { context: before, command: [checkedTool(before, "cargo")].concat(args), output });
}
