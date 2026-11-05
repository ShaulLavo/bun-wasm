import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { chmod, copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer, createConnection, type Socket } from "node:net";
import { createSecureContext, TLSSocket, connect as tlsConnect } from "node:tls";

/** Exact values owned by one run. No message, phase or stack is hidden wholesale. */
export class RunSecrets {
  private readonly forms = new Set<string>();
  private sorted: readonly string[] = [];
  add(value: string | Uint8Array): void {
    const renderings = typeof value === "string" ? [value] : byteRenderings(value);
    for (const rendering of renderings) {
      if (rendering.length < 16) throw new Error("A run secret is too short to redact without hiding ordinary text");
      for (const form of [rendering, JSON.stringify(rendering).slice(1, -1), encodeURIComponent(rendering)]) this.forms.add(form);
    }
    this.sorted = Array.from(this.forms).sort((a, b) => b.length - a.length);
  }
  renderings(): readonly string[] { return this.sorted; }
  redact(text: string): string { return this.sorted.reduce((redacted, form) => redacted.split(form).join("[redacted run secret]"), text); }
  tail(limit: number): RedactedTail { return new RedactedTail(this, limit); }
}
function byteRenderings(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [buffer.toString("hex"), buffer.toString("base64"), buffer.toString("base64url"), Array.from(bytes).join(","), Array.from(bytes).join(", "),
    Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" "), inspect(buffer), inspect(bytes), inspect(new Uint8Array(bytes))];
}
function prefixOverlap(text: string, form: string): number {
  for (let length = Math.min(text.length, form.length - 1); length > 0; length--) if (text.endsWith(form.slice(0, length))) return length;
  return 0;
}
function firstSecret(text: string, forms: readonly string[]): { index: number; form: string } | undefined {
  let found: { index: number; form: string } | undefined;
  for (const form of forms) {
    const index = text.indexOf(form);
    if (index >= 0 && (!found || index < found.index)) found = { index, form };
  }
  return found;
}
/** Commit only secret-safe text; a possible split value stays in a bounded raw suffix. */
class RedactedTail {
  private committed = "";
  private pending = "";
  constructor(private readonly secrets: RunSecrets, private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("A diagnostic tail needs a positive limit");
  }
  write(chunk: string): void {
    let text = this.pending + chunk;
    this.pending = "";
    const forms = this.secrets.renderings();
    while (text.length) {
      const boundary = forms.reduce((cut, form) => Math.min(cut, text.length - prefixOverlap(text, form)), text.length);
      const match = firstSecret(text, forms);
      if (!match || boundary <= match.index) {
        this.commit(text.slice(0, boundary));
        this.pending = text.slice(boundary);
        return;
      }
      this.commit(text.slice(0, match.index) + "[redacted run secret]");
      text = text.slice(match.index + match.form.length);
    }
  }
  read(): string { return this.secrets.redact(this.committed + this.pending).slice(-this.limit); }
  private commit(text: string): void { this.committed = (this.committed + text).slice(-this.limit); }
}

export const PI_POSTGRES_IMAGE = "docker.io/library/postgres@sha256:7a8050e52090c5f77effbe7e0cbed4a0587306776c3f26dc99933a63c619eaf1";
const PI_POSTGRES_CONFIG = "c54a696c68013b2f8f42f479e00a2b6ad24c5ef10ee31cdfb8972cec3dad7eb7";
export type PodmanRun = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;
function tailscaleAddress(value: string): boolean {
  const octets = value.split(".").map(Number);
  return octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 255) <= 127 && octets.join(".") === value;
}
export function piPostgresPlan(home: string, id: string, bind: string, relayCidr: string) {
  if (!isAbsolute(home) || resolve(home) !== home || !/^[a-f0-9]{24}$/.test(id) || !tailscaleAddress(bind)
    || !relayCidr.endsWith("/32") || !tailscaleAddress(relayCidr.slice(0, -3)) || relayCidr === bind + "/32") throw new Error("Invalid Pi PostgreSQL owner paths or addresses");
  const name = `bun-wasm-tls-${id}`, volume = `${name}-data`, root = join(home, "tmp", name);
  // Rootless port forwarding may rewrite the peer address. The published socket
  // is Tailscale-only; all container TCP authentication still requires TLS and SCRAM.
  const hba = "local all all peer\nhostnossl all all 0.0.0.0/0 reject\nhostssl all all 0.0.0.0/0 scram-sha-256\n";
  const createArgs = ["create", "--pull=never", "--name", name, "--memory=768m", "--cpus=1.5", "--pids-limit=128", "--shm-size=128m",
    "--publish", `${bind}:45433:5432`, "--volume", `${volume}:/var/lib/postgresql/data`, "--env", "POSTGRES_PASSWORD_FILE=/run/tls/password",
    "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=peer", "--entrypoint", "/bin/sh", PI_POSTGRES_IMAGE,
    "-c", 'chown postgres:postgres /run/tls /run/tls/server.key /run/tls/server.pem /run/tls/password /run/tls/pg_hba.conf && exec docker-entrypoint.sh "$@"', "tls-postgres",
    "postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=20", "-c", "password_encryption=scram-sha-256", "-c", "ssl=on",
    "-c", "ssl_cert_file=/run/tls/server.pem", "-c", "ssl_key_file=/run/tls/server.key", "-c", "hba_file=/run/tls/pg_hba.conf",
    "-c", "log_connections=off", "-c", "logging_collector=off"];
  return { name, volume, root, image: PI_POSTGRES_IMAGE, bind, relayCidr, hba, createArgs };
}
function imageObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid prepared Pi image metadata");
  return Object.fromEntries(Object.entries(value));
}
export function assertPiPostgresImage(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Prepared digest-pinned Pi PostgreSQL image missing");
  const row = imageObject(value[0]);
  if (typeof row.Id !== "string" || row.Id.replace(/^sha256:/, "") !== PI_POSTGRES_CONFIG || row.Architecture !== "arm64" || row.Os !== "linux"
    || row.Digest !== PI_POSTGRES_IMAGE.split("@")[1]) throw new Error("Prepared Pi PostgreSQL image identity mismatch");
  return { id: row.Id, digest: row.Digest, architecture: row.Architecture, os: row.Os };
}
/** A failed fixture command keeps what it was and how it ended: subcommand, exit code or signal, and its stderr tail. */
export class FixtureCommandError extends Error {
  constructor(readonly command: string, readonly code: number | string | null, readonly signal: string | null, readonly stderr: string) {
    super(`${command} ${signal ? `ended by ${signal}` : `exited ${code}`}${stderr ? `: ${stderr}` : ""}`);
  }
}
type CommandOptions = ExecFileOptions & { readonly secrets?: RunSecrets };
export async function execute(executable: string, args: readonly string[], options: CommandOptions, allowed: readonly number[] = [0]) {
  const result = Promise.withResolvers<{ code: number; stdout: string }>();
  const { secrets = new RunSecrets(), ...commandOptions } = options;
  const stderr = secrets.tail(4096);
  const child = execFile(executable, args, { ...commandOptions, encoding: "utf8" }, (error, stdout) => {
    const code = error ? error.code : 0;
    if (typeof code === "number" && allowed.includes(code)) { result.resolve({ code, stdout }); return; }
    const command = [executable].concat(args.slice(0, 2)).join(" ");
    result.reject(new FixtureCommandError(command, code ?? null, error?.signal ?? null, stderr.read().trim()));
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr.write(chunk); });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try { return await result.promise; } finally { await closed; }
}
async function requireAbsent(kind: "container" | "volume", name: string, run: PodmanRun): Promise<void> {
  if ((await run([kind, "exists", name])).code !== 1) throw new Error(`Pi PostgreSQL ${kind} absence unconfirmed`);
}
async function removeOwned(kind: "container" | "volume", name: string, removal: readonly string[], run: PodmanRun): Promise<void> {
  if ((await run(removal)).code !== 0) throw new Error(`Pi PostgreSQL ${kind} removal failed`);
  await requireAbsent(kind, name, run);
}
/**
 * `podman volume rm` takes no --ignore, so absence is asked first: a volume
 * this run never created (partial setup) or already removed is confirmed
 * absent and left alone. A present volume gets plain `volume rm <name>`;
 * Podman refuses it (exit 2) while a container uses it, and that refusal
 * keeps its exit code and stderr. Absence is checked again afterwards.
 */
async function removeOwnedVolume(name: string, run: PodmanRun): Promise<void> {
  if ((await run(["volume", "exists", name])).code === 1) return;
  await removeOwned("volume", name, ["volume", "rm", name], run);
}
/**
 * Each owned object is removed and proven absent on its own, so a container
 * step that fails or is not yet confirmed never skips the volume. The volume
 * is removed without --force: Podman itself refuses it while any container
 * still uses it, so nothing in use is released. Every concrete error is kept.
 */
export async function removePiPostgres(plan: ReturnType<typeof piPostgresPlan>, owned: { container: boolean; volume: boolean }, run: PodmanRun): Promise<void> {
  const failures: unknown[] = [];
  if (owned.container) await removeOwned("container", plan.name, ["rm", "--force", "--ignore", plan.name], run).catch(error => { failures.push(error); });
  if (owned.volume) await removeOwnedVolume(plan.volume, run).catch(error => { failures.push(error); });
  if (failures.length) throw new AggregateError(failures, "Pi PostgreSQL removal unconfirmed");
  // Images are prepared and owned by Engines. No pull, alias, prune or rmi here.
}
/** One stderr line naming every failure the owner saw, so the PC driver can record the concrete cause. */
export function ownerFailureLine(failures: readonly unknown[], secrets: RunSecrets = new RunSecrets()): string {
  const describe = (error: unknown): unknown => {
    if (!(error instanceof Error)) return { value: String(error) };
    const inner = error instanceof AggregateError ? { errors: error.errors.map(describe) } : {};
    return { name: error.name, message: error.message, code: Reflect.get(error, "code") ?? null, signal: Reflect.get(error, "signal") ?? null, ...inner };
  };
  return secrets.redact(JSON.stringify({ kind: "pi-postgres-owner-failures", failures: failures.map(describe) })) + "\n";
}
export async function postgresOwner(root: string, bind: string, relayCidr: string): Promise<void> {
  const id = root.slice(root.lastIndexOf("bun-wasm-tls-") + "bun-wasm-tls-".length);
  const plan = piPostgresPlan(homedir(), id, bind, relayCidr);
  if (root !== plan.root) throw new Error("Pi PostgreSQL scratch must be under its remote home/tmp");
  const abort = new AbortController();
  const secrets = new RunSecrets();
  const options = { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, signal: abort.signal, secrets };
  const owned = { container: false, volume: false };
  const failures: unknown[] = [];
  let rootOwned = false;
  let waiter: ReturnType<typeof spawn> | undefined;
  let waitClosed: Promise<void> | undefined;
  let guard: Awaited<ReturnType<typeof startStartupGuard>> | undefined;
  const stopped = Promise.withResolvers<void>();
  const stop = () => { abort.abort(new Error("Pi TLS fixture stopped")); stopped.resolve(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  const timer = setTimeout(stop, 11 * 60_000);
  const commands = startupCommands(() => guard, stop);
  void commands.done.then(stop, stop);
  const pod: PodmanRun = args => execute("podman", args, { timeout: 30_000, maxBuffer: 1024 * 1024, signal: abort.signal, secrets }, args[1] === "exists" ? [0, 1] : [0]);
  const cleanPod: PodmanRun = args => execute("podman", args, { timeout: 30_000, maxBuffer: 1024 * 1024, secrets }, args[1] === "exists" ? [0, 1] : [0]);
  try {
    await checkPiHost(bind, abort.signal);
    await requireAbsent("container", plan.name, pod);
    await requireAbsent("volume", plan.volume, pod);
    const image = assertPiPostgresImage(JSON.parse((await pod(["image", "inspect", plan.image])).stdout));
    if (await realpath(join(homedir(), "tmp")) !== join(homedir(), "tmp")) throw new Error("Pi scratch parent must not redirect");
    abort.signal.throwIfAborted();
    await mkdir(root, { mode: 0o700 });
    rootOwned = true;
    let password = randomBytes(32).toString("base64url");
    secrets.add(password);
    await prepareSecrets(plan, password, options);
    await rm(join(root, "ca.key"));
    abort.signal.throwIfAborted();
    owned.volume = true;
    await pod(["volume", "create", plan.volume]);
    owned.container = true;
    await pod(plan.createArgs);
    await pod(["cp", join(root, "container"), `${plan.name}:/run/tls`]);
    await pod(["start", plan.name]);
    await ready(plan.name, abort.signal, secrets);
    const publication = (await pod(["port", plan.name])).stdout.trim();
    if (publication !== `5432/tcp -> ${bind}:45433`) throw new Error("Pi PostgreSQL publication must bind only the selected Tailscale address");
    const auth = (await pod(["exec", "--user", "postgres", plan.name, "psql", "-XAt", "-U", "postgres", "-c", "SELECT current_setting('ssl') = 'on' AND current_setting('password_encryption') = 'scram-sha-256' AND rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname = 'postgres'"])).stdout.trim();
    if (auth !== "t") throw new Error("Pi PostgreSQL TLS/SCRAM configuration was not observed");
    await rm(join(root, "container/password"));
    guard = await startStartupGuard(root, bind, abort.signal);
    const guardObservedBytes = await armStartupGuard(root, bind, guard, abort.signal);
    abort.signal.throwIfAborted();
    waiter = spawn("podman", ["wait", plan.name], { stdio: ["ignore", "ignore", "ignore"] });
    waitClosed = new Promise<void>(resolve => { waiter?.once("close", () => resolve()); waiter?.once("error", () => resolve()); });
    const exited = waitClosed.then(() => { if (!abort.signal.aborted) throw new Error("Pi PostgreSQL exited before teardown"); });
    void exited.catch(() => {});
    process.stdout.write(JSON.stringify({ guardObservedBytes, guardPort: 45434, ca: await readFile(join(root, "ca.pem"), "utf8"), password, port: 45433, root,
      container: plan.name, volume: plan.volume, image, publication, tlsScramObserved: true }) + "\n");
    password = "";
    await Promise.race([stopped.promise, exited]);
  } catch (error) { failures.push(error); } finally {
    stop();
    const settled = await Promise.allSettled([Promise.resolve().then(() => guard?.close()), removePiPostgres(plan, owned, cleanPod)]);
    waiter?.kill("SIGTERM");
    await waitClosed;
    for (const row of settled) if (row.status === "rejected") failures.push(row.reason);
    // These files were copied, not mounted. Remove host secrets even if Podman stop failed.
    const scratch = await Promise.allSettled([rootOwned ? rm(root, { recursive: true, force: true }) : Promise.resolve()]);
    for (const row of scratch) if (row.status === "rejected") failures.push(row.reason);
    commands.close();
    await commands.done;
    clearTimeout(timer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
  }
  if (!failures.length) return;
  process.stderr.write(ownerFailureLine(failures, secrets));
  throw new AggregateError(failures, "Pi PostgreSQL fixture failed or cleanup unconfirmed");
}
async function checkPiHost(bind: string, signal: AbortSignal): Promise<void> {
  const busy = join(homedir(), ".local/state/machine-fleet/owner-busy");
  const present = await stat(busy).then(() => true, error => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; });
  if (present) throw new Error("Pi is reserved by the owner");
  const memory = await readFile("/proc/meminfo", "utf8");
  if (Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1] ?? 0) < 1536 * 1024) throw new Error("Pi has less than 1536 MiB available");
  const options = { timeout: 5000, signal };
  if ((await execute("tailscale", ["ip", "-4"], options)).stdout.trim() !== bind) throw new Error("Pi Tailscale address mismatch");
  if ((await execute("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], options)).stdout.trim() !== "true") throw new Error("Pi Podman must be rootless");
}
async function prepareSecrets(plan: ReturnType<typeof piPostgresPlan>, password: string, options: CommandOptions): Promise<void> {
  await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=bun-wasm run CA", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE"], options);
  options.secrets?.add(await readFile(join(plan.root, "ca.key"), "utf8"));
  await execute("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=pg.tls.test"], options);
  options.secrets?.add(await readFile(join(plan.root, "server.key"), "utf8"));
  await writeFile(join(plan.root, "extensions"), "subjectAltName=DNS:pg.tls.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  await execute("openssl", ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "extensions"], options);
  await chmod(join(plan.root, "server.key"), 0o600);
  const directory = join(plan.root, "container");
  await mkdir(directory, { mode: 0o700 });
  for (const name of ["server.key", "server.pem"]) await copyFile(join(plan.root, name), join(directory, name));
  await writeFile(join(directory, "password"), password, { mode: 0o600 });
  await writeFile(join(directory, "pg_hba.conf"), plan.hba, { mode: 0o600 });
}
async function ready(container: string, signal: AbortSignal, secrets: RunSecrets): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    signal.throwIfAborted();
    try { await execute("podman", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-t", "3", "-U", "postgres"], { timeout: 20_000, signal, secrets }); return; }
    catch { signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error("Pi PostgreSQL did not become ready within its bounded startup");
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
    if (server.listening || sockets.size) throw new Error("Pi TLS observer cleanup unconfirmed");
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

function startupCommands(owner: () => Awaited<ReturnType<typeof startStartupGuard>> | undefined, stop: () => void) {
  const lines = createInterface({ input: process.stdin });
  const done = new Promise<void>(resolve => {
    const audit = () => owner()?.drain().then(() => process.stdout.write(JSON.stringify({ plaintextBytes: owner()?.reset() }) + "\n")).catch(stop);
    lines.on("line", line => line === "guard-audit" ? audit() : lines.close());
    lines.once("close", () => { stop(); resolve(); });
  });
  return { done, close: () => lines.close() };
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
