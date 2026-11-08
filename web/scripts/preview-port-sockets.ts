import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { dispatchPreviewHTTP } from "../preview-origin-host";

export interface SocketAliasOwner {
  ownsOrigin(origin: string): boolean;
  fetchPort(port: number, request: Request): Promise<Response>;
  upgradePort(port: number, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
}
type SocketLease = { owner: null } | { owner: SocketAliasOwner; hostname: string };
interface Alias {
  port: number;
  server: Server;
  owners: Map<SocketAliasOwner, Set<string>>;
  ready: Promise<void>;
  sockets: Map<Duplex, SocketLease>;
  lifetime: AbortController;
  closing?: Promise<void>;
}

/** Hostname leases share literal loopback listeners, never another owner's grant. */
export class PreviewPortSockets {
  private readonly ports = new Map<number, Alias>();
  private hostPorts = 0;
  private sockets = 0;

  async reserve(port: number, owner: SocketAliasOwner, hostname = "127.0.0.1"): Promise<void> {
    if (hostname !== "127.0.0.1" && !/^bw-[a-f0-9-]+\.localhost$/.test(hostname)) throw new Error("Preview aliases require an allocated loopback hostname");
    let alias = this.ports.get(port);
    if (alias?.closing) { await alias.closing; return this.reserve(port, owner, hostname); }
    const existing = alias && hasHostname(alias, hostname);
    if (!existing && this.hostPorts >= 512) throw new Error("Preview socket alias limit");
    if (!alias) { alias = this.listen(port); this.ports.set(port, alias); }
    if (!existing) this.hostPorts++;
    const hosts = alias.owners.get(owner) ?? new Set<string>();
    hosts.add(hostname);
    alias.owners.set(owner, hosts);
    try { await alias.ready; }
    catch (error) {
      if (this.ports.get(port) === alias) { this.hostPorts -= new Set(Array.from(alias.owners.values()).flatMap(hosts => Array.from(hosts))).size; this.ports.delete(port); }
      throw error;
    }
  }
  async release(port: number, owner: SocketAliasOwner): Promise<void> {
    const alias = this.ports.get(port);
    if (alias) await this.releaseAlias(alias, owner);
  }
  async releaseHost(hostname: string, owner: SocketAliasOwner): Promise<void> {
    await Promise.all(Array.from(this.ports.values(), alias => this.releaseAlias(alias, owner, hostname)));
  }
  private async releaseAlias(alias: Alias, owner: SocketAliasOwner, hostname?: string): Promise<void> {
    const hosts = alias.owners.get(owner);
    if (!hosts || hostname !== undefined && !hosts.has(hostname)) { await alias.closing; return; }
    const removed = hostname === undefined ? Array.from(hosts) : [hostname];
    for (const host of removed) hosts.delete(host);
    if (!hosts.size) alias.owners.delete(owner);
    for (const host of removed) if (!hasHostname(alias, host)) this.hostPorts--;
    for (const [socket, lease] of alias.sockets) if (lease.owner === owner && (hostname === undefined || lease.hostname === hostname)) socket.destroy();
    if (alias.owners.size) return;
    alias.closing ??= this.closeAlias(alias);
    await alias.closing;
  }
  private async closeAlias(alias: Alias): Promise<void> {
    await alias.ready;
    alias.lifetime.abort();
    for (const socket of alias.sockets.keys()) socket.destroy();
    await new Promise<void>((resolve, reject) => alias.server.close(error => error ? reject(error) : resolve()));
    if (this.ports.get(alias.port) === alias) this.ports.delete(alias.port);
  }
  async closeOwner(owner: SocketAliasOwner): Promise<void> {
    await Promise.all(Array.from(this.ports.values(), alias => this.releaseAlias(alias, owner)));
  }

  private listen(port: number): Alias {
    const server = createServer((request, response) => {
      const hostname = aliasHostname(port, request.headers.host);
      const owner = aliasOwner(alias, hostname, request.headers.origin);
      if (!hostname || !owner) { response.writeHead(403); response.end(); return; }
      if (!claimSocket(alias, request.socket, owner, hostname)) { response.writeHead(421); response.end(); return; }
      void dispatchPreviewHTTP(request, response, `http://${request.headers.host}`, { fetch: request => owner.fetchPort(port, request) }, alias.lifetime.signal, source => owner.ownsOrigin(source));
    });
    const alias: Alias = { port, server, owners: new Map(), sockets: new Map(), lifetime: new AbortController(), ready: new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(port, "127.0.0.1", resolve);
    }) };
    server.on("connection", socket => {
      if (this.sockets >= 256 || alias.sockets.size >= 64) { socket.destroy(); return; }
      this.sockets++; alias.sockets.set(socket, { owner: null });
      socket.on("error", () => socket.destroy());
      socket.once("close", () => { if (alias.sockets.delete(socket)) this.sockets--; });
    });
    server.on("upgrade", (request, socket, head) => { void upgradeAlias(alias, request, socket, head); });
    return alias;
  }
}

function hasHostname(alias: Alias, hostname: string): boolean {
  for (const hosts of alias.owners.values()) if (hosts.has(hostname)) return true;
  return false;
}

function aliasHostname(port: number, authority: string | undefined): string | undefined {
  const hostname = authority?.split(":")[0];
  if (hostname && (authority === `${hostname}:${port}` || port === 80 && authority === hostname)) return hostname;
}

function aliasOwner(alias: Alias, hostname: string | undefined, origin: string | undefined): SocketAliasOwner | undefined {
  if (!hostname || !origin) return;
  const lease = hostname === "localhost" ? "127.0.0.1" : hostname;
  for (const [owner, hosts] of alias.owners) if (hosts.has(lease) && owner.ownsOrigin(origin)) return owner;
}

function claimSocket(alias: Alias, socket: Duplex, owner: SocketAliasOwner, hostname: string): boolean {
  const existing = alias.sockets.get(socket);
  if (existing?.owner && (existing.owner !== owner || existing.hostname !== hostname)) return false;
  alias.sockets.set(socket, { owner, hostname });
  return true;
}

async function upgradeAlias(alias: Alias, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const hostname = aliasHostname(alias.port, request.headers.host);
  const path = request.url ?? "/";
  if (!hostname || !hasHostname(alias, hostname === "localhost" ? "127.0.0.1" : hostname) || !path.startsWith("/") || path.startsWith("//")) {
    socket.end("HTTP/1.1 421 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
  }
  const owner = aliasOwner(alias, hostname, request.headers.origin);
  if (!owner || !claimSocket(alias, socket, owner, hostname)) {
    socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
  }
  try { if (!await owner.upgradePort(alias.port, request, socket, head)) socket.destroy(); } catch { socket.destroy(); }
}
