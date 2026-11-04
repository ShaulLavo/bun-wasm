import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Server as HttpServer } from "node:http";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireOwned, deadline, type TlsCleanup } from "../../scripts/tls-qualification-lifecycle.ts";
import { object, text, recheckDependencies, type TlsIntake } from "../../scripts/tls-qualification-inputs.ts";

import { type QualificationCase as PgCase } from "../../scripts/tls-qualification-context.ts";
export interface ServiceOptions {
  readonly databaseMachine: string;
  readonly databaseAddress: string;
  readonly relayAddress: string;
  readonly pagePort: number;
  readonly relayPort: number;
}
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
async function database(owner: TlsCleanup, options: ServiceOptions, signal: AbortSignal, record: (resource: object) => Promise<void>) {
  signal.throwIfAborted();
  const root = `/work/tmp/bun-wasm-tls-${randomBytes(12).toString("hex")}`;
  const code = await readFile(new URL("../../tests/servers/tls.ts", import.meta.url), "utf8");
  const program = code + `\nawait postgresOwner(${JSON.stringify(root)}, ${JSON.stringify(options.databaseAddress)}, ${JSON.stringify(options.relayAddress + "/32")});`;
  await record({ host: options.databaseMachine, kind: "remote-postgres-owner", root, ports: [45433, 45434] });
  const spawned = await acquireOwned(owner, signal, () => {
    const child = spawn("mesh", ["ssh", options.databaseMachine, "--", "bun", "--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("Remote PostgreSQL owner failed"))); });
    void exited.catch(() => {});
    child.stderr.resume();
    return { child, exited };
  }, async ({ child, exited }) => {
    child.stdin.end("stop\n");
    const kill = setTimeout(() => child.kill("SIGTERM"), 20_000);
    let failure: unknown;
    try { await deadline(exited, new AbortController().signal, 30_000); } catch (error) { failure = error; child.kill("SIGKILL"); await exited.catch(() => {}); }
    finally { clearTimeout(kill); }
    const absence = spawnSync("mesh", ["ssh", options.databaseMachine, "--", "test", "!", "-e", root], { timeout: 15_000, stdio: "ignore" });
    await record({ host: options.databaseMachine, root, absenceCommandExit: absence.status, absenceSignal: absence.signal, childExitCode: child.exitCode, childSignal: child.signalCode });
    if (absence.error || absence.status !== 0) throw new Error("Remote fixture scratch absence unconfirmed");
    if (failure) throw failure;
  });
  const { child, exited } = spawned;
  const lines = createInterface({ input: child.stdout });
  const responses = lines[Symbol.asyncIterator]();
  const first = responses.next().then(row => row.done ? undefined : JSON.parse(row.value));
  const row = object(await deadline(Promise.race([first, exited]), signal, 90_000), "private database response");
  if (row.guardObservedBytes !== Buffer.byteLength("TLS_STARTUP_OBSERVER_CONTROL") || row.guardPort !== 45434) throw new Error("Real TLS startup observer did not arm");
  if (row.port !== 45433) throw new Error("Unexpected PostgreSQL target port");
  return { ca: text(row.ca, "generated CA"), password: text(row.password, "generated password"), root, pid: row.pid,
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
export async function startTlsServices(intake: TlsIntake, owner: TlsCleanup, options: ServiceOptions, signal: AbortSignal, record: (resource: object) => Promise<void>) {
  signal.throwIfAborted();
  await recheckDependencies(intake);
  signal.throwIfAborted();
  const db = await database(owner, options, signal, record);
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
  owner.add(() => { secret.fill(0); });
  const entry = pathToFileURL(Bun.resolveSync("waffle-relay/node", join(intake.inputs.hostSource, "web"))).href;
  signal.throwIfAborted();
  await recheckDependencies(intake);
  signal.throwIfAborted();
  const adapter: unknown = await import(entry);
  const module = object(adapter, "released relay module");
  if (typeof module.createNodeRelayServer !== "function") throw new Error("Missing reviewed relay109 raw TCP entry");
  const createRelay = module.createNodeRelayServer;
  const destinations = ["pg.tls.test", "wrong.tls.test", "reject.tls.test"].map(host => ({ host, port: 5432, connect: { host: "127.0.0.1", port: proxyPort } }));
  const relay = object(await acquireOwned(owner, signal, () => createRelay({ credential: randomBytes(32).toString("hex"), allowedOrigins: [`http://127.0.0.1:${options.pagePort}`], tcp: { tokenSecret: secret, destinations, log() {} } }), async value => { const row = object(value, "relay owner"); if (typeof row.close !== "function") throw new Error("Missing reviewed relay close operation"); await row.close(); }), "relay owner");
  if (!(relay.server instanceof HttpServer) || typeof relay.close !== "function") throw new Error("Invalid relay109 lifecycle");
  const server = relay.server;
  const close = relay.close.bind(relay);
  owner.add(async () => { await close(); secret.fill(0); if (server.listening || object(relay.tcp, "relay TCP").active !== 0) throw new Error("TLS relay cleanup unconfirmed"); });
  const tcp = object(relay.tcp, "relay TCP owner");
  await deadline(Promise.resolve(tcp.ready), signal, 15_000);
  await record({ kind: "relay", port: options.relayPort, destinationPort: proxyPort });
  await listen(server, options.relayPort, signal);
  signal.throwIfAborted();
  const tokenModule = object(await import(pathToFileURL(Bun.resolveSync("waffle-relay/token", join(intake.inputs.hostSource, "web"))).href), "relay token module");
  if (typeof tokenModule.mintRelayToken !== "function") throw new Error("Missing relay token signer");
  const mint = tokenModule.mintRelayToken;
  return {
    lifecycle: () => ({ relayActive: object(relay.tcp, "relay TCP owner").active, relayListening: server.listening, proxyListening: proxy.listening, proxySockets: sockets.size }),
    ca: db.ca, password: db.password,
    select(mode: PgCase) { selected = mode; },
    token: async () => text(await mint(secret, { exp: Math.floor(Date.now() / 1000) + 300, sub: "tls-qualification", dst: destinations.map(({ host, port }) => ({ host, port })) }), "relay token"),
    async audit(mode: PgCase) {
      const rows = audits.get(mode);
      if (!rows || rows.length !== 1) throw new Error("TLS pg must use exactly one underlying TCP connection per case");
      return { wire: rows.map(row => row.result()), startup: await db.startupAudit() };
    },
    resources: { remoteMachine: options.databaseMachine, root: db.root, pid: db.pid, proxyPort, relayPort: options.relayPort },
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
