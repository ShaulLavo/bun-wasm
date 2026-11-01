import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { inspectProbeLinkMap } from "./tls-probe-symbols.ts";
import { createProbeCertificates } from "./tls-probe-certificates.ts";

const root = resolve(import.meta.dir, "..");
export const boringSslPin = "41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f";
const profileFlags = "-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK";
const inputs = ["crates/bunwasm-crypto-sys/src/lib.rs", "scripts/tls-probe.test.ts", "checks/cmake-tls-probe.json", "scripts/tls-probe-symbols.ts", "crates/bunwasm-crypto-sys/build.rs", "crates/bunwasm-crypto-sys/src/tls.rs", "tests/native/tls-probe.cpp", "jsc/wasi-jsc.cmake", "scripts/tls-probe.ts", "scripts/tls-probe-wasi.ts", "scripts/tls-probe-server.ts", "scripts/tls-probe-certificates.ts"];
type ProbeCase = { name: string; version: "1.2" | "1.3"; ca: string; cert: string; hostname: string; verify: number };
type Capture = { stdout: string; stderr: string };

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

let commandLog: string | undefined;
function command(executable: string, args: readonly string[]): string {
  if (commandLog) writeFileSync(commandLog, JSON.stringify({ executable, args }) + "\n", { flag: "a" });
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 2_700_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function capture(child: ChildProcess): Capture {
  const result = { stdout: "", stderr: "" };
  child.on("error", error => { result.stderr += error.message; });
  child.stdout?.on("data", (data: Buffer) => { result.stdout += data.toString(); assert.ok(result.stdout.length <= 65536, "bounded fixture output"); });
  child.stderr?.on("data", (data: Buffer) => { result.stderr += data.toString(); assert.ok(result.stderr.length <= 65536, "bounded diagnostics"); });
  return result;
}

async function stop(child: ChildProcess): Promise<void> {
  const closed = child.exitCode === null && child.signalCode === null ? once(child, "close") : undefined;
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
  await closed;
}

async function waitForText(child: ChildProcess, output: Capture, text: RegExp, signal: AbortSignal): Promise<RegExpExecArray> {
  for (;;) {
    const match = text.exec(output.stdout);
    if (match) return match;
    if (!child.stdout || child.exitCode !== null || child.signalCode !== null) throw new Error(`Native fixture exited: ${output.stderr}`);
    await once(child.stdout, "data", { signal });
  }
}

function frame(data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}

function bridge(child: ChildProcess, socket: Socket): { bytes: number } {
  let pending: Buffer = Buffer.alloc(0);
  const count = { bytes: 0 };
  child.stdin?.on("error", () => {});
  child.stdout?.on("data", (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0);
      assert.ok(size <= 16384 && pending.length <= 65536, "bounded ciphertext framing");
      if (pending.length < size + 4) return;
      const bytes = pending.subarray(4, size + 4);
      pending = pending.subarray(size + 4);
      count.bytes += size;
      if (size === 0) socket.end();
      else socket.write(bytes);
    }
  });
  socket.on("data", (data: Buffer) => {
    for (let offset = 0; offset < data.length; offset += 1024) child.stdin?.write(frame(data.subarray(offset, offset + 1024)));
  });
  socket.on("end", () => child.stdin?.end(frame(Buffer.alloc(0))));
  socket.on("error", () => child.stdin?.destroy());
  return count;
}

async function runCase(binary: string, certificates: ReturnType<typeof createProbeCertificates>, test: ProbeCase) {
  const deadline = AbortSignal.timeout(30_000);
  const server = spawn("node", [join(root, "scripts/tls-probe-server.ts"), certificates.key, test.cert, `TLSv${test.version}`], { stdio: ["ignore", "pipe", "pipe"], signal: deadline, detached: true });
  const oracle = capture(server);
  let guest: ChildProcess | undefined;
  let socket: Socket | undefined;
  try {
    const listen = await waitForText(server, oracle, /^listening (\d+)/, deadline);
    const port = Number(listen[1]);
    socket = connect(port, "127.0.0.1");
    await once(socket, "connect", { signal: deadline });
    const start = performance.now();
    const args = binary.endsWith(".wasm")
      ? ["wasmtime", "run", "--dir", `${certificates.root}::/certs`, binary, `/certs/${test.ca}`, test.hostname, test.version]
      : [binary, join(certificates.root, test.ca), test.hostname, test.version];
    guest = spawn("/usr/bin/time", ["-f", "max-rss-kib=%M"].concat(args), { stdio: ["pipe", "pipe", "pipe"], signal: deadline, detached: true });
    const stderr = { value: "" };
    guest.on("error", error => { stderr.value += error.message; });
    guest.stderr?.on("data", (data: Buffer) => { stderr.value += data.toString(); });
    const closed = once(guest, "close", { signal: deadline });
    const ciphertext = bridge(guest, socket);
    const [status, signal] = await closed;
    const elapsedMs = performance.now() - start;
    assert.equal(signal, null, `guest terminated: ${stderr.value}`);
    assert.equal(status, test.verify === 0 ? 0 : 10, stderr.value);
    if (test.verify === 0) {
      await waitForText(server, oracle, /peer-close-notify=ok/, deadline);
      assertSuccess(test, stderr.value, oracle.stdout);
    }
    else assertRejection(test, stderr.value, oracle.stdout);
    return { name: test.name, status, elapsedMs, stderr: stderr.value, oracle, ciphertextBytes: ciphertext.bytes };
  } finally {
    socket?.destroy();
    if (guest) await stop(guest);
    await stop(server);
  }
}

function assertSuccess(test: ProbeCase, stderr: string, oracle: string): void {
  assert.ok(stderr.includes(`success version=TLSv${test.version} alpn=probe/1 verify=0 payload=ok close-notify=ok`), stderr);
  assert.ok(oracle.includes(`secure version=TLSv${test.version} alpn=probe/1 sni=tls-probe.test`), oracle);
  assert.ok(oracle.includes("payload=ok"), oracle);
}

function assertRejection(test: ProbeCase, stderr: string, oracle: string): void {
  assert.ok(stderr.includes(`rejected verify=${test.verify}\n`), stderr);
  assert.ok(!stderr.includes("success") && !oracle.includes("payload=ok"), "certificate failure must precede application bytes");
}

export async function qualifyProbe(binary: string, scratchRoot: string) {
  const scratch = mkdtempSync(join(scratchRoot, "bun-wasm-tls-cases-"));
  try {
    const certs = createProbeCertificates(join(scratch, "certs"));
    const cases: ProbeCase[] = [
      { name: "tls12-valid", version: "1.2", ca: certs.ca, cert: certs.cert, hostname: "tls-probe.test", verify: 0 },
      { name: "tls13-valid", version: "1.3", ca: certs.ca, cert: certs.cert, hostname: "tls-probe.test", verify: 0 },
      { name: "unknown-ca-rejected", version: "1.3", ca: certs.unknown, cert: certs.cert, hostname: "tls-probe.test", verify: 20 },
      { name: "expired-peer-rejected", version: "1.3", ca: certs.ca, cert: certs.expired, hostname: "tls-probe.test", verify: 10 },
      { name: "hostname-rejected", version: "1.3", ca: certs.ca, cert: certs.cert, hostname: "wrong.test", verify: 62 },
    ];
    const results = [];
    for (const test of cases) results.push(await runCase(binary, certs, test));
    const native = join(scratchRoot, "tls-probe-native");
    const nativeResult = await runCase(native, certs, { name: "native-tls13-valid", version: "1.3", ca: certs.ca, cert: certs.cert, hostname: "tls-probe.test", verify: 0 });
    const entropy = spawnSync("node", [join(root, "scripts/tls-probe-wasi.ts"), binary, certs.root, "fail", "/certs/ca.pem", "tls-probe.test", "1.3"], { encoding: "utf8", timeout: 10_000 });
    if (entropy.error) throw entropy.error;
    assert.notEqual(entropy.status, 0, "failing random_get must abort");
    assert.ok(entropy.stderr.includes("tls-probe entropy-import-failure") && entropy.stderr.includes("unreachable"), entropy.stderr);
    return { results, nativeResult, entropy: { status: entropy.status, stderr: entropy.stderr } };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function sdkPaths() {
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sdk || !sysroot) throw new Error("source env.sh before running TLS G0");
  return { sdk, sysroot };
}

function size(binary: string, output: string) {
  command("wasm-tools", ["strip", binary, "-o", output]);
  const bytes = readFileSync(output);
  return { raw: readFileSync(binary).length, stripped: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, brotli: brotliCompressSync(bytes).length, sha256: hash(binary), sections: command("wasm-tools", ["objdump", output]) };
}

function authenticateSource(source: string, output: string) {
  const scratch = mkdtempSync(join(output, "source-proof-"));
  const url = `https://codeload.github.com/oven-sh/boringssl/tar.gz/${boringSslPin}`;
  try {
    const archive = join(scratch, "source.tar.gz");
    const expected = join(scratch, "source");
    mkdirSync(expected);
    command("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "120", url, "-o", archive]);
    command("tar", ["xzf", archive, "--strip-components=1", "-C", expected]);
    command("diff", ["-qr", source, expected]);
    return { url, archiveSha256: hash(archive), fullDirectoryMatchesPinnedArchive: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function buildProbe(source: string, build: string, output: string) {
  const { sdk, sysroot } = sdkPaths();
  if (process.env.BUN_WASM_PROGRAM_PROFILE) throw new Error("G0 requires the default unshared split profile");
  mkdirSync(build, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  commandLog = join(output, "commands.jsonl");
  const sourceProof = authenticateSource(source, output);
  const configure = ["-S", source, "-B", build, "-G", "Ninja", `-DCMAKE_TOOLCHAIN_FILE=${join(root, "jsc/wasi-jsc.cmake")}`, "-DCMAKE_BUILD_TYPE=MinSizeRel", "-DOPENSSL_NO_ASM=1", "-DBUILD_TESTING=OFF", `-DCMAKE_C_FLAGS=${profileFlags}`, `-DCMAKE_CXX_FLAGS=${profileFlags} -fno-exceptions -fno-rtti`];
  writeFileSync(join(output, "configure.log"), command("cmake", configure));
  writeFileSync(join(build, "bunwasm-program-profile"), "split");
  writeFileSync(join(output, "build.log"), command("cmake", ["--build", build, "--target", "crypto", "ssl", "--parallel", "2"]));
  const binary = join(output, "tls-probe.wasm");
  const baseline = join(output, "crypto-only.wasm");
  const flags = ["--target=wasm32-wasip1", "-O2", "-fno-exceptions", "-fno-rtti", `--sysroot=${sysroot}`, "-I" + join(source, "include"), join(root, "tests/native/tls-probe.cpp")];
  const link = [join(build, "libssl.a"), join(build, "libcrypto.a"), `-L${sysroot}/lib/wasm32-wasip1/noeh`, `-L${sysroot}/lib/wasm32-wasip1`, "-lc++", "-lc++abi"];
  command(join(sdk, "bin/clang++"), flags.concat(link, ["-Wl,-Map=" + join(output, "tls.map"), "-o", binary]));
  command(join(sdk, "bin/clang++"), flags.concat(["-DTLS_PROBE_BASELINE"], link, ["-o", baseline]));
  const sizes = { baseline: size(baseline, join(output, "crypto-only.stripped.wasm")), tls: size(binary, join(output, "tls-probe.stripped.wasm")) };
  writeFileSync(join(output, "sizes.json"), JSON.stringify(sizes, null, 2) + "\n");
  const map = readFileSync(join(output, "tls.map"), "utf8");
  const artifactHashes = { binary: hash(binary), baseline: hash(baseline), sslArchive: hash(join(build, "libssl.a")), cryptoArchive: hash(join(build, "libcrypto.a")) };
  writeFileSync(join(output, "compiled-hashes.json"), JSON.stringify(artifactHashes, null, 2) + "\n");
  const symbols = inspectProbeLinkMap(map);
  writeFileSync(join(output, "symbols.json"), JSON.stringify(symbols, null, 2) + "\n");
  const nativeBuild = join(build, "native");
  command("cmake", ["-S", source, "-B", nativeBuild, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=MinSizeRel", "-DOPENSSL_NO_ASM=1", "-DBUILD_TESTING=OFF", "-DCMAKE_C_COMPILER=/usr/bin/cc", "-DCMAKE_CXX_COMPILER=/usr/bin/c++"]);
  writeFileSync(join(output, "native-build.log"), command("cmake", ["--build", nativeBuild, "--target", "crypto", "ssl", "--parallel", "2"]));
  command("/usr/bin/c++", ["-O2", "-I" + join(source, "include"), join(root, "tests/native/tls-probe.cpp"), join(nativeBuild, "libssl.a"), join(nativeBuild, "libcrypto.a"), "-lpthread", "-o", join(output, "tls-probe-native")]);
  const receipt = { symbols, kind: "bun-wasm.tls-g0-probe.v1", boringSslPin, sourceProof, baseHead: command("git", ["rev-parse", "HEAD"]).trim(), binarySha256: hash(binary), nativeSha256: hash(join(output, "tls-probe-native")), configure, compile: flags.concat(link), sourceInputs: Object.fromEntries(inputs.map(path => [path, hash(join(root, path))])), profile: readFileSync(join(build, "bunwasm-program-profile"), "utf8"), sysrootSha256: hash(join(sysroot, "bun-wasm-sysroot.json")), sizes };
  writeFileSync(join(output, "build.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

export function requireProbeEvidence(output: string | undefined): string {
  if (!output) throw new Error("BUNWASM_TLS_PROBE_OUTPUT is required; selected G0 cannot skip missing evidence");
  const binary = join(resolve(output), "tls-probe.wasm");
  const receipt: unknown = JSON.parse(readFileSync(join(output, "build.json"), "utf8"));
  assert.ok(receipt && typeof receipt === "object" && "kind" in receipt && "sourceProof" in receipt && "binarySha256" in receipt && "nativeSha256" in receipt && "sourceInputs" in receipt && "profile" in receipt && "boringSslPin" in receipt);
  assert.equal(receipt.binarySha256, hash(binary));
  assert.equal(receipt.nativeSha256, hash(join(output, "tls-probe-native")));
  assert.equal(receipt.kind, "bun-wasm.tls-g0-probe.v1");
  assert.ok(receipt.sourceProof && typeof receipt.sourceProof === "object" && "url" in receipt.sourceProof && "fullDirectoryMatchesPinnedArchive" in receipt.sourceProof);
  assert.equal(receipt.sourceProof.url, `https://codeload.github.com/oven-sh/boringssl/tar.gz/${boringSslPin}`);
  assert.equal(receipt.sourceProof.fullDirectoryMatchesPinnedArchive, true);
  assert.equal(receipt.profile, "split");
  assert.equal(receipt.boringSslPin, boringSslPin);
  assert.deepEqual(receipt.sourceInputs, Object.fromEntries(inputs.map(path => [path, hash(join(root, path))])));
  return binary;
}

export async function inspectProbe(binary: string) {
  const module = await WebAssembly.compile(readFileSync(binary));
  const imports = WebAssembly.Module.imports(module);
  const allowed = new Set(["args_get", "args_sizes_get", "clock_time_get", "environ_get", "environ_sizes_get", "fd_close", "fd_fdstat_get", "fd_fdstat_set_flags", "fd_filestat_get", "fd_read", "fd_seek", "fd_write", "fd_prestat_get", "fd_prestat_dir_name", "path_filestat_get", "path_open", "proc_exit", "random_get"]);
  for (const entry of imports) assert.ok(entry.module === "wasi_snapshot_preview1" && entry.kind === "function" && allowed.has(entry.name), `unexpected import ${JSON.stringify(entry)}`);
  for (const name of ["random_get", "clock_time_get"]) assert.ok(imports.some(entry => entry.name === name), `missing ${name}`);
  const skeleton = command("wasm-tools", ["print", "--skeleton", binary]);
  assert.ok(!/\(memory[^\n]*shared|\(import[^\n]*(sock_|pthread_|__cxa_throw|__cxa_allocate_exception)/.test(skeleton), "unshared single-executor imports");
  return imports;
}

if (import.meta.main) {
  process.umask(0o077);
  const [source, build, output] = ["--source", "--build", "--output"].map(flag => {
    const index = process.argv.indexOf(flag);
    const value = process.argv[index + 1];
    if (index < 0 || !value) throw new Error(`Required ${flag}`);
    return resolve(value);
  });
  assert.ok(source && build && output);
  await buildProbe(source, build, output);
  if (!process.argv.includes("--compile-only")) {
    const binary = requireProbeEvidence(output);
    const result = { imports: await inspectProbe(binary), ...await qualifyProbe(binary, output) };
    writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
