import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createServer, createConnection, type Socket } from "node:net";
import { createSecureContext, TLSSocket, connect as tlsConnect } from "node:tls";

const execute = promisify(execFile);
export async function postgresOwner(root: string, bind: string, relayCidr: string): Promise<void> {
  if (!/^\/work\/tmp\/bun-wasm-tls-[a-zA-Z0-9-]+$/.test(root) || !/^[\d.]+$/.test(bind) || !/^[\d.]+\/32$/.test(relayCidr)) throw new Error("Invalid PostgreSQL owner paths or addresses");
  const mount = await execute("findmnt", ["-T", "/work/tmp", "-n", "-o", "TARGET"], { timeout: 5000 });
  if (!mount.stdout.trim().startsWith("/work")) throw new Error("PostgreSQL fixture requires the mounted data drive");
  await mkdir(root, { mode: 0o700 });
  const password = randomBytes(32).toString("base64url");
  const options = { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 };
  let child: ReturnType<typeof spawn> | undefined;
  let interrupted = false;
  const stopped = Promise.withResolvers<void>();
  let exited: Promise<void> | undefined;
  let guard: Awaited<ReturnType<typeof startStartupGuard>> | undefined;
  const stop = () => { interrupted = true; stopped.resolve(); child?.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=bun-wasm run CA", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE"], options);
    await execute("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=pg.tls.test"], options);
    await writeFile(join(root, "extensions"), "subjectAltName=DNS:pg.tls.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
    await execute("openssl", ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "extensions"], options);
    await chmod(join(root, "server.key"), 0o600);
    await writeFile(join(root, "password"), password, { mode: 0o600 });
    await execute("initdb", ["-D", "data", "--username=postgres", "--pwfile=password", "--auth-local=peer", "--auth-host=scram-sha-256"], options);
    await rm(join(root, "password"));
    await writeFile(join(root, "data/pg_hba.conf"), `local all all peer\nhostnossl all all 0.0.0.0/0 reject\nhostssl all all ${relayCidr} scram-sha-256\n`);
    await writeFile(join(root, "data/postgresql.conf"), `listen_addresses='${bind}'\nport=45433\nssl=on\nssl_cert_file='${root}/server.pem'\nssl_key_file='${root}/server.key'\npassword_encryption='scram-sha-256'\nunix_socket_directories='${root}'\nlogging_collector=off\nlog_connections=off\n`);
    if (interrupted) throw new Error("PostgreSQL setup cancelled");
    child = spawn("postgres", ["-D", join(root, "data")], { stdio: ["ignore", "ignore", "ignore"] });
    exited = new Promise<void>((resolve, reject) => { child?.once("error", reject); child?.once("close", code => code === 0 || interrupted ? resolve() : reject(new Error("PostgreSQL owner exited"))); });
    void exited.catch(() => {});
    await ready(root, bind, options, () => interrupted);
    guard = await startStartupGuard(root, bind);
    await armStartupGuard(root, bind, guard);
    process.stdout.write(JSON.stringify({ guardArmed: true, guardPort: 45434, ca: await readFile(join(root, "ca.pem"), "utf8"), password, port: 45433, pid: child.pid }) + "\n");
    await Promise.race([stopped.promise, exited, startupCommands(() => guard, stop)]);
    stop();
    await exited;
  } finally {
    stop();
    const killTimer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    try { await guard?.close(); await exited; } finally { clearTimeout(killTimer); await rm(root, { recursive: true, force: true }); }
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
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

async function startStartupGuard(root: string, bind: string) {
  const context = createSecureContext({ key: await readFile(join(root, "server.key")), cert: await readFile(join(root, "server.pem")) });
  const sockets = new Set<Socket>();
  let plaintextBytes = 0;
  const server = createServer(socket => startupConnection(context, sockets, count => { plaintextBytes += count; }, socket));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.listening ? server.close(error => error ? reject(error) : resolve()) : resolve());
  };
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(45434, bind, () => { server.removeListener("error", reject); resolve(); }); }); }
  catch (error) { await close(); throw error; }
  return { close, async drain() {
    for (let attempt = 0; sockets.size && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    if (sockets.size) throw new Error("TLS startup observer still owns live connections");
  }, reset() { const count = plaintextBytes; plaintextBytes = 0; return count; } };
}
async function armStartupGuard(root: string, host: string, guard: Awaited<ReturnType<typeof startStartupGuard>>): Promise<void> {
  const ca = await readFile(join(root, "ca.pem"));
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port: 45434 });
    socket.on("error", reject);
    socket.setTimeout(15_000, () => socket.destroy(new Error("Startup observer control timeout")));
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.once("data", bytes => controlUpgrade(socket, ca, bytes, resolve, reject));
  });
  if (guard.reset() !== Buffer.byteLength("TLS_STARTUP_OBSERVER_CONTROL")) throw new Error("Startup observer did not arm on its real TLS endpoint");
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
