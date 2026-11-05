import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Server as HttpServer } from "node:http";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireOwned, deadline, type TlsCleanup } from "../../scripts/tls-qualification-lifecycle.ts";
import { object, text, recheckDependencies, type TlsIntake } from "../../scripts/tls-qualification-inputs.ts";
import type { TlsFixtureOptions as ServiceOptions } from "../../scripts/c1/contract.ts";
import { hostToolPath, type HostTools } from "../../scripts/c1/replay.ts";
import type { RunSecrets } from "../../scripts/tls-qualification.ts";

import { piPostgresPlan } from "../../tests/servers/tls.ts";

import { type QualificationCase as PgCase } from "../../scripts/tls-qualification-context.ts";
export class PgWireAudit {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private requested = false;
  public bytes = 0;
  public invalid = false;
  public sslRequests = 0;
  constructor(readonly mode: PgCase) {}
  accept(data: Uint8Array): void {
    this.bytes += data.byteLength;
    if (this.mode === "plaintext") return;
    let offset = 0;
    while (offset < data.byteLength) offset = this.consume(data, offset);
  }
  private consume(data: Uint8Array, offset: number): number {
    if (this.remaining) {
      const count = Math.min(this.remaining, data.byteLength - offset);
      this.remaining -= count;
      return offset + count;
    }
    if (this.requested && this.mode === "rejection") { this.invalid = true; return data.byteLength; }
    const wanted = this.requested ? 5 : 8;
    const count = Math.min(wanted - this.header.length, data.byteLength - offset);
    this.header = Buffer.concat([this.header, data.subarray(offset, offset + count)]);
    if (this.header.length !== wanted) return offset + count;
    if (!this.requested) this.sslRequest();
    else this.record();
    this.header = Buffer.alloc(0);
    return offset + count;
  }
  private sslRequest(): void {
    if (this.header.readUInt32BE(0) !== 8 || this.header.readUInt32BE(4) !== 80877103) this.invalid = true;
    this.requested = true;
    this.sslRequests++;
  }
  private record(): void {
    const type = this.header[0];
    const length = this.header.readUInt16BE(3);
    if (![20, 21, 22, 23].includes(type ?? 0) || this.header[1] !== 3 || (this.header[2] ?? 255) > 3 || length > 18432) this.invalid = true;
    this.remaining = length;
  }
  result() {
    if (this.header.length || this.remaining || this.invalid || this.mode !== "plaintext" && this.sslRequests !== 1 || this.mode === "rejection" && this.bytes !== 8) throw new Error("Plaintext before TLS or invalid PostgreSQL SSLRequest");
    return { mode: this.mode, bytes: this.bytes, sslRequests: this.sslRequests, plaintextStartupObserved: this.mode === "plaintext" };
  }
}
function listen(server: Server | HttpServer, port: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clean = () => { server.removeListener("error", failed); signal.removeEventListener("abort", cancelled); };
    const failed = (error: unknown) => { clean(); reject(error); };
    const cancelled = () => { clean(); server.close(); reject(signal.reason); };
    server.once("error", failed);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) { cancelled(); return; }
    server.listen({ port, host: "127.0.0.1", signal }, () => { clean(); if (signal.aborted) return reject(signal.reason); resolve(); });
  });
}
async function closeListener(server: Server | HttpServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.listening ? server.close(error => error ? reject(error) : resolve()) : resolve());
  if (server.listening || sockets.size) throw new Error("TLS wire listener cleanup unconfirmed");
}
function track(sockets: Set<Socket>, socket: Socket): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => socket.destroy());
}
/**
 * The lease holder: flock runs the declared shell, which reports the lock and then waits in the declared cat until stdin closes.
 * The lease always ends with its cleanup, so a refused remote cleanup can never keep the driver's event loop alive.
 * An unreconciled remote fixture is left exactly as it is, named in the ledger, and still fails the run.
 */
export async function piLane(owner: TlsCleanup, signal: AbortSignal, closed: () => boolean, tools: HostTools, lock = "/work/tmp/wave-heavy/pi.lock") {
  const argv = ["--nonblock", lock, hostToolPath(tools, "sh"), "-c", "printf 'locked\\n'; exec \"$1\" >/dev/null", "sh", hostToolPath(tools, "cat")];
  const lease = await acquireOwned(owner, signal, () => {
    const child = spawn(hostToolPath(tools, "flock"), argv, { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("Pi lane lock unavailable"))); });
    void exited.catch(() => {});
    return { child, exited };
  }, async ({ child, exited }) => {
    const reconciled = closed();
    child.stdin.end();
    try { await deadline(exited, new AbortController().signal, 5000); }
    catch (error) { child.kill("SIGKILL"); throw error; }
    if (!reconciled) throw new Error("Pi lane released with the remote PostgreSQL fixture unreconciled; its named container, volume and scratch stay for reconciliation under a fresh pi.lock");
  });
  const lines = createInterface({ input: lease.child.stdout });
  try {
    const row = await deadline(Promise.race([lines[Symbol.asyncIterator]().next(), lease.exited.then(() => { throw new Error("Pi lane lock exited"); })]), signal, 5000);
    if (row.value !== "locked") throw new Error("Pi lane lock not observed");
    return { pid: lease.child.pid };
  } finally { lines.close(); }
}
/** The last bytes a child wrote to stderr, for its failure record. Redacted where it is recorded. */
export function stderrTail(stream: NodeJS.ReadableStream, limit = 64 * 1024): () => string {
  let tail = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => { tail = (tail + chunk).slice(-limit); });
  return () => tail;
}
async function database(owner: TlsCleanup, options: ServiceOptions, signal: AbortSignal, record: (resource: object) => Promise<void>, tools: HostTools, secrets: RunSecrets) {
  const mesh = hostToolPath(tools, "mesh");
  signal.throwIfAborted();
  if (options.databaseMachine !== "pi") throw new Error("TLS PostgreSQL fixture requires the approved Pi host");
  let remoteClosed = true;
  const lease = await piLane(owner, signal, () => remoteClosed, tools);
  await record({ kind: "pi-lane-lock", path: "/work/tmp/wave-heavy/pi.lock", holderPid: lease.pid, acquired: true });
  const home = execFileSync(mesh, ["ssh", options.databaseMachine, "--", "sh", "-c", 'printf "%s" "$HOME"'], { encoding: "utf8", timeout: 15_000 }).trim();
  const plan = piPostgresPlan(home, randomBytes(12).toString("hex"), options.databaseAddress, options.relayAddress + "/32");
  const root = plan.root;
  const code = await readFile(new URL("../../tests/servers/tls.ts", import.meta.url), "utf8");
  const program = code + `\nawait postgresOwner(${JSON.stringify(root)}, ${JSON.stringify(options.databaseAddress)}, ${JSON.stringify(options.relayAddress + "/32")});`;
  await record({ host: options.databaseMachine, kind: "remote-podman-postgres-owner", root, container: plan.name, volume: plan.volume, image: plan.image, imageCleanupOwner: "parent provisioner", ports: [45433, 45434], piLaneLock: "/work/tmp/wave-heavy/pi.lock" });
  const spawned = await acquireOwned(owner, signal, () => {
    remoteClosed = false;
    const child = spawn(mesh, ["ssh", options.databaseMachine, "--", "bun", "--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = stderrTail(child.stderr);
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, closedBy) => code === 0 ? resolve() : reject(new Error(`Remote PostgreSQL owner exited ${code ?? closedBy}: ${secrets.redact(stderr()).trim()}`)));
    });
    void exited.catch(() => {});
    return { child, exited, stderr };
  }, async ({ child, exited, stderr }) => {
    child.stdin.end("stop\n");
    const kill = setTimeout(() => child.kill("SIGTERM"), 150_000);
    let failure: unknown;
    try { await deadline(exited, new AbortController().signal, 160_000); } catch (error) { failure = error; child.kill("SIGKILL"); await exited.catch(() => {}); }
    finally { clearTimeout(kill); }
    const verifier = `import { spawnSync } from "node:child_process"; import { existsSync } from "node:fs"; import { createServer } from "node:net";
      const container = spawnSync("podman", ["container", "exists", ${JSON.stringify(plan.name)}], { timeout: 15000 });
      const volume = spawnSync("podman", ["volume", "exists", ${JSON.stringify(plan.volume)}], { timeout: 15000 });
      const row = { scratchAbsent: !existsSync(${JSON.stringify(root)}), containerAbsent: container.status === 1, volumeAbsent: volume.status === 1 };
      const ports = await Promise.all([45433, 45434].map(port => new Promise(resolve => {
        const server = createServer(); server.once("error", () => resolve(false));
        server.listen(port, ${JSON.stringify(options.databaseAddress)}, () => server.close(error => resolve(!error)));
      })));
      process.stdout.write(JSON.stringify({ ...row, portsAbsent: ports.every(Boolean) }));
      if (!Object.values(row).every(value => value === true) || !ports.every(Boolean)) process.exitCode = 1;`;
    const absence = spawnSync(mesh, ["ssh", options.databaseMachine, "--", "bun", "--eval", verifier], { timeout: 45_000, encoding: "utf8" });
    await record({ host: options.databaseMachine, root, container: plan.name, volume: plan.volume, absenceCommandExit: absence.status, absenceSignal: absence.signal, observation: absence.stdout,
      absenceStderr: secrets.redact(absence.stderr ?? ""), childExitCode: child.exitCode, childSignal: child.signalCode, ownerStderr: secrets.redact(stderr()) });
    if (absence.error || absence.status !== 0) throw new Error("Remote Pi PostgreSQL container/volume/scratch absence unconfirmed");
    remoteClosed = true;
    if (failure) throw failure;
  });
  const { child, exited } = spawned;
  const lines = createInterface({ input: child.stdout });
  const responses = lines[Symbol.asyncIterator]();
  const first = responses.next().then(row => row.done ? undefined : JSON.parse(row.value));
  const row = object(await deadline(Promise.race([first, exited]), signal, 180_000), "private database response");
  secrets.add(text(row.password, "generated password"));
  if (row.guardObservedBytes !== Buffer.byteLength("TLS_STARTUP_OBSERVER_CONTROL") || row.guardPort !== 45434) throw new Error("Real TLS startup observer did not arm");
  if (row.port !== 45433 || row.root !== root || row.container !== plan.name || row.volume !== plan.volume || row.publication !== `5432/tcp -> ${options.databaseAddress}:45433` || row.tlsScramObserved !== true) throw new Error("Unexpected Pi PostgreSQL fixture identity");
  await record({ kind: "remote-postgres-ready", host: options.databaseMachine, container: plan.name, volume: plan.volume, image: row.image, publication: row.publication, tlsScramObserved: true });
  return { ca: text(row.ca, "generated CA"), password: text(row.password, "generated password"), root, container: plan.name, volume: plan.volume, image: row.image,
    async startupAudit() {
      signal.throwIfAborted();
      child.stdin.write("guard-audit\n");
      const response = await deadline(responses.next(), signal, 15_000);
      const audit = object(JSON.parse(response.value ?? "null"), "startup audit");
      if (audit.plaintextBytes !== 0) throw new Error("PostgreSQL startup/password bytes reached the TLS failure endpoint");
      return { plaintextBytes: audit.plaintextBytes, positiveControl: { observedBytes: row.guardObservedBytes, port: row.guardPort } };
    },
  };
}
export async function startTlsServices(intake: TlsIntake, owner: TlsCleanup, options: ServiceOptions, signal: AbortSignal, record: (resource: object) => Promise<void>, secrets: RunSecrets) {
  signal.throwIfAborted();
  await recheckDependencies(intake);
  signal.throwIfAborted();
  const db = await database(owner, options, signal, record, intake.hostTools, secrets);
  let selected: PgCase = "verified";
  const audits = new Map<PgCase, PgWireAudit[]>();
  const sockets = new Set<Socket>();
  const proxy = await acquireOwned(owner, signal, () => createServer({ allowHalfOpen: true }, socket => {
    if (signal.aborted) { socket.destroy(); return; }
    track(sockets, socket);
    const audit = new PgWireAudit(selected);
    audits.set(selected, (audits.get(selected) ?? []).concat([audit]));
    if (selected === "rejection") { rejectSslRequest(socket, audit); return; }
    const upstream = createConnection({ host: options.databaseAddress, port: selected === "no-extra-ca" || selected === "hostname" ? 45434 : 45433, allowHalfOpen: true });
    track(sockets, upstream);
    socket.on("data", bytes => { if (typeof bytes === "string") throw new Error("Expected binary TCP data"); audit.accept(bytes); });
    socket.pipe(upstream); upstream.pipe(socket);
    upstream.on("error", () => socket.destroy());
  }), proxy => closeListener(proxy, sockets));
  await listen(proxy, 0, signal);
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing TLS proxy listener address");
  const proxyPort = proxyAddress.port;
  await record({ kind: "raw-proxy", port: proxyPort });
  signal.throwIfAborted();
  const secret = randomBytes(32);
  secrets.add(secret);
  owner.add(() => { secret.fill(0); });
  const entry = pathToFileURL(Bun.resolveSync("waffle-relay/node", join(intake.hostSource, "web"))).href;
  signal.throwIfAborted();
  await recheckDependencies(intake);
  signal.throwIfAborted();
  const adapter: unknown = await import(entry);
  const module = object(adapter, "released relay module");
  if (typeof module.createNodeRelayServer !== "function") throw new Error("Missing reviewed relay109 raw TCP entry");
  const createRelay = module.createNodeRelayServer;
  const destinations = ["pg.tls.test", "wrong.tls.test", "reject.tls.test"].map(host => ({ host, port: 5432, connect: { host: "127.0.0.1", port: proxyPort } }));
  const credential = randomBytes(32).toString("hex");
  secrets.add(credential);
  const relay = object(await acquireOwned(owner, signal, () => createRelay({ credential, allowedOrigins: [`http://127.0.0.1:${options.pagePort}`], tcp: { tokenSecret: secret, destinations, log() {} } }), async value => { const row = object(value, "relay owner"); if (typeof row.close !== "function") throw new Error("Missing reviewed relay close operation"); await row.close(); }), "relay owner");
  if (!(relay.server instanceof HttpServer) || typeof relay.close !== "function") throw new Error("Invalid relay109 lifecycle");
  const server = relay.server;
  const close = relay.close.bind(relay);
  owner.add(async () => { await close(); secret.fill(0); if (server.listening || object(relay.tcp, "relay TCP").active !== 0) throw new Error("TLS relay cleanup unconfirmed"); });
  const tcp = object(relay.tcp, "relay TCP owner");
  await deadline(Promise.resolve(tcp.ready), signal, 15_000);
  await record({ kind: "relay", port: options.relayPort, destinationPort: proxyPort });
  await listen(server, options.relayPort, signal);
  signal.throwIfAborted();
  const tokenModule = object(await import(pathToFileURL(Bun.resolveSync("waffle-relay/token", join(intake.hostSource, "web"))).href), "relay token module");
  if (typeof tokenModule.mintRelayToken !== "function") throw new Error("Missing relay token signer");
  const mint = tokenModule.mintRelayToken;
  return {
    lifecycle: () => ({ relayActive: object(relay.tcp, "relay TCP owner").active, relayListening: server.listening, proxyListening: proxy.listening, proxySockets: sockets.size }),
    ca: db.ca, password: db.password,
    select(mode: PgCase) { selected = mode; },
    async token() {
      const token = text(await mint(secret, { exp: Math.floor(Date.now() / 1000) + 300, sub: "tls-qualification", dst: destinations.map(({ host, port }) => ({ host, port })) }), "relay token");
      secrets.add(token);
      return token;
    },
    async audit(mode: PgCase) {
      const rows = audits.get(mode);
      if (!rows || rows.length !== 1) throw new Error("TLS pg must use exactly one underlying TCP connection per case");
      return { wire: rows.map(row => row.result()), startup: await db.startupAudit() };
    },
    resources: { remoteMachine: options.databaseMachine, root: db.root, container: db.container, volume: db.volume, image: db.image, proxyPort, relayPort: options.relayPort },
  };
}

function rejectSslRequest(socket: Socket, audit: PgWireAudit): void {
  let answered = false;
  socket.on("data", bytes => {
    if (typeof bytes === "string") throw new Error("Expected binary TCP data");
    audit.accept(bytes);
    if (answered || audit.sslRequests !== 1) return;
    answered = true;
    socket.write("N");
  });
  socket.on("end", () => socket.end());
}
