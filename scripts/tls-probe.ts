import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { tlsProbeServerPath } from "./tls-probe-server.ts";
import { tlsProbeWasiPath } from "./tls-probe-wasi.ts";
import { createProbeCertificates } from "./tls-probe-certificates.ts";

const boringSslPin = "41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f";

type ProbeCase = { name: string; version: "1.2" | "1.3"; ca: string; cert: string; hostname: string; verify: number };
type Capture = { stdout: string; stderr: string };

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function command(executable: string, args: readonly string[]): string {
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
  const server = spawn("node", [tlsProbeServerPath, certificates.key, test.cert, `TLSv${test.version}`], { stdio: ["ignore", "pipe", "pipe"], signal: deadline, detached: true });
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
    socket.end();
    await waitForText(server, oracle, /^terminal applicationBytes=\d+$/m, deadline);
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

export function assertRejection(test: Pick<ProbeCase, "verify">, stderr: string, oracle: string): void {
  assert.ok(stderr.includes(`rejected verify=${test.verify}\n`), stderr);
  const terminal = Array.from(oracle.matchAll(/^terminal applicationBytes=(\d+)$/gm));
  assert.equal(terminal.length, 1, "certificate control needs one terminal server observation");
  assert.equal(terminal[0]?.[1], "0", "certificate failure must precede every application byte");
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
    const entropy = spawnSync("node", [tlsProbeWasiPath, binary, certs.root, "fail", "/certs/ca.pem", "tls-probe.test", "1.3"], { encoding: "utf8", timeout: 10_000 });
    if (entropy.error) throw entropy.error;
    assert.notEqual(entropy.status, 0, "failing random_get must abort");
    assert.ok(entropy.stderr.includes("tls-probe entropy-import-failure") && entropy.stderr.includes("unreachable"), entropy.stderr);
    return { results, nativeResult, entropy: { status: entropy.status, stderr: entropy.stderr } };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function authenticateSource(source: string, output: string) {
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


export { requireTrustedProbe as requireProbeEvidence } from "./tls-probe-handoff.ts";
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

if (import.meta.main) throw new Error("The standalone crypto builder is removed. Use the recorded native-quality TLS producer and native-probe owner.");
