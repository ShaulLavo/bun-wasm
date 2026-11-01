import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createServer, createConnection, type Socket } from "node:net";
import { createSecureContext, TLSSocket, connect as tlsConnect } from "node:tls";

async function execute(executable: string, args: readonly string[], options: ExecFileOptions) {
  const result = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const child = execFile(executable, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => error ? result.reject(error) : result.resolve({ stdout, stderr }));
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try { return await result.promise; } finally { await closed; }
}
export async function postgresOwner(root: string, bind: string, relayCidr: string): Promise<void> {
  if (!/^\/work\/tmp\/bun-wasm-tls-[a-zA-Z0-9-]+$/.test(root) || !/^[\d.]+$/.test(bind) || !/^[\d.]+\/32$/.test(relayCidr)) throw new Error("Invalid PostgreSQL owner paths or addresses");
  const abort = new AbortController();
  const options = { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, signal: abort.signal };
  let rootOwned = false;
  let child: ReturnType<typeof spawn> | undefined;
  let interrupted = false;
  const stopped = Promise.withResolvers<void>();
  let exited: Promise<void> | undefined;
  let guard: Awaited<ReturnType<typeof startStartupGuard>> | undefined;
  const stop = () => { interrupted = true; abort.abort(new Error("Native fixture stopped")); stopped.resolve(); child?.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  try {
    abort.signal.throwIfAborted();
    const mount = await execute("findmnt", ["-T", "/work/tmp", "-n", "-o", "TARGET"], { timeout: 5000, signal: abort.signal });
    if (!mount.stdout.trim().startsWith("/work")) throw new Error("PostgreSQL fixture requires the mounted data drive");
    abort.signal.throwIfAborted();
    await mkdir(root, { mode: 0o700 });
    rootOwned = true;
    abort.signal.throwIfAborted();
    const password = randomBytes(32).toString("base64url");
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=bun-wasm run CA", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE"], options);
    await execute("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=pg.tls.test"], options);
    abort.signal.throwIfAborted();
    await writeFile(join(root, "extensions"), "subjectAltName=DNS:pg.tls.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
    await execute("openssl", ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "extensions"], options);
    abort.signal.throwIfAborted();
    await chmod(join(root, "server.key"), 0o600);
    abort.signal.throwIfAborted();
    await writeFile(join(root, "password"), password, { mode: 0o600 });
    await execute("initdb", ["-D", "data", "--username=postgres", "--pwfile=password", "--auth-local=peer", "--auth-host=scram-sha-256"], options);
    abort.signal.throwIfAborted();
    await rm(join(root, "password"));
    abort.signal.throwIfAborted();
    await writeFile(join(root, "data/pg_hba.conf"), `local all all peer\nhostnossl all all 0.0.0.0/0 reject\nhostssl all all ${relayCidr} scram-sha-256\n`);
    abort.signal.throwIfAborted();
    await writeFile(join(root, "data/postgresql.conf"), `listen_addresses='${bind}'\nport=45433\nssl=on\nssl_cert_file='${root}/server.pem'\nssl_key_file='${root}/server.key'\npassword_encryption='scram-sha-256'\nunix_socket_directories='${root}'\nlogging_collector=off\nlog_connections=off\n`);
    if (interrupted) throw new Error("PostgreSQL setup cancelled");
    child = spawn("postgres", ["-D", join(root, "data")], { stdio: ["ignore", "ignore", "ignore"] });
    exited = new Promise<void>((resolve, reject) => { child?.once("error", reject); child?.once("close", code => code === 0 || interrupted ? resolve() : reject(new Error("PostgreSQL owner exited"))); });
    void exited.catch(() => {});
    await ready(root, bind, options, () => interrupted);
    abort.signal.throwIfAborted();
    guard = await startStartupGuard(root, bind, abort.signal);
    const guardObservedBytes = await armStartupGuard(root, bind, guard, abort.signal);
    process.stdout.write(JSON.stringify({ guardObservedBytes, guardPort: 45434, ca: await readFile(join(root, "ca.pem"), "utf8"), password, port: 45433, pid: child.pid }) + "\n");
    await Promise.race([stopped.promise, exited, startupCommands(() => guard, stop)]);
    stop();
    await exited;
  } finally {
    stop();
    const killTimer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    try {
      await cleanupNativeFixture(root, rootOwned, guard, exited);
    } finally {
      clearTimeout(killTimer);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGHUP", stop);
    }
  }
}
async function ready(root: string, host: string, options: { cwd: string; timeout: number; maxBuffer: number }, cancelled: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (cancelled()) throw new Error("PostgreSQL readiness cancelled");
    try { await execute("pg_isready", ["-h", host, "-p", "45433", "-t", "1"], { ...options, timeout: 3000 }); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error(`PostgreSQL did not become ready in ${root}`);
}

async function startStartupGuard(root: string, bind: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = await readFile(join(root, "server.key")), cert = await readFile(join(root, "server.pem"));
  signal.throwIfAborted();
  const context = createSecureContext({ key, cert });
  const sockets = new Set<Socket>();
  let plaintextBytes = 0;
  const server = createServer(socket => startupConnection(context, sockets, count => { plaintextBytes += count; }, socket));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.listening ? server.close(error => error ? reject(error) : resolve()) : resolve());
  };
  try { await bindStartupGuard(server, bind, signal); signal.throwIfAborted(); }
  catch (error) { await close(); throw error; }
  return { close, async drain() {
    for (let attempt = 0; sockets.size && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    if (sockets.size) throw new Error("TLS startup observer still owns live connections");
  }, reset() { const count = plaintextBytes; plaintextBytes = 0; return count; } };
}
async function armStartupGuard(root: string, host: string, guard: Awaited<ReturnType<typeof startStartupGuard>>, signal: AbortSignal): Promise<number> {
  const ca = await readFile(join(root, "ca.pem"));
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port: 45434, signal });
    socket.on("error", reject);
    socket.setTimeout(15_000, () => socket.destroy(new Error("Startup observer control timeout")));
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.once("data", bytes => controlUpgrade(socket, ca, bytes, resolve, reject));
  });
  const observedBytes = guard.reset();
  if (observedBytes !== Buffer.byteLength("TLS_STARTUP_OBSERVER_CONTROL")) throw new Error("Startup observer did not arm on its real TLS endpoint");
  return observedBytes;
}

function startupConnection(context: ReturnType<typeof createSecureContext>, sockets: Set<Socket>, count: (bytes: number) => void, socket: Socket): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => socket.destroy());
  let request = Buffer.alloc(0);
  const upgrade = (data: Buffer) => {
    request = Buffer.concat([request, data]);
    if (request.length < 8) return;
    socket.removeListener("data", upgrade);
    if (request.length !== 8 || request.readUInt32BE(0) !== 8 || request.readUInt32BE(4) !== 80877103) { count(request.length); socket.destroy(); return; }
    socket.write("S");
    const secure = new TLSSocket(socket, { isServer: true, secureContext: context });
    secure.on("error", () => secure.destroy());
    secure.on("data", bytes => { count(bytes.length); });
    secure.on("end", () => secure.end());
  };
  socket.on("data", upgrade);
}

function controlUpgrade(socket: Socket, ca: Buffer, bytes: Buffer | string, done: () => void, fail: (reason: Error) => void): void {
  if (bytes.toString() !== "S") { socket.destroy(); fail(new Error("Startup observer SSLRequest control failed")); return; }
  const secure = tlsConnect({ socket, ca, servername: "pg.tls.test" });
  secure.on("error", fail);
  secure.once("secureConnect", () => secure.end("TLS_STARTUP_OBSERVER_CONTROL"));
  secure.once("close", done);
}

function startupCommands(owner: () => Awaited<ReturnType<typeof startStartupGuard>> | undefined, stop: () => void): Promise<void> {
  return new Promise(resolve => {
    const lines = createInterface({ input: process.stdin });
    const audit = () => owner()?.drain().then(() => process.stdout.write(JSON.stringify({ plaintextBytes: owner()?.reset() }) + "\n")).catch(stop);
    lines.on("line", line => line === "guard-audit" ? audit() : lines.close());
    lines.once("close", resolve);
  });
}

function bindStartupGuard(server: ReturnType<typeof createServer>, host: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clean = () => { server.removeListener("error", failed); signal.removeEventListener("abort", cancel); };
    const failed = (error: unknown) => { clean(); reject(error); };
    const cancel = () => { clean(); server.close(); reject(signal.reason); };
    server.once("error", failed);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    server.listen({ port: 45434, host, signal }, () => { clean(); resolve(); });
  });
}

async function cleanupNativeFixture(root: string, owned: boolean, guard: Awaited<ReturnType<typeof startStartupGuard>> | undefined, exited: Promise<void> | undefined): Promise<void> {
  const settled = await Promise.allSettled([Promise.resolve().then(() => guard?.close()), exited]);
  const failures = settled.filter(row => row.status === "rejected").map(row => row.reason);
  if (failures.length) throw new AggregateError(failures, "Native fixture cleanup failed; preserve owned scratch until physical stop is confirmed");
  if (owned) await rm(root, { recursive: true, force: true });
}
