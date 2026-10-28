import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { dispatchPreviewHTTP } from "../preview-origin-host";

export interface SocketAliasOwner {
  ownsOrigin(origin: string): boolean;
  fetchPort(port: number, request: Request): Promise<Response>;
  upgradePort(port: number, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
}
interface Alias {
  hostname: string;
  port: number;
  server: Server;
  owners: Set<SocketAliasOwner>;
  ready: Promise<void>;
  sockets: Map<Duplex, SocketAliasOwner | null>;
  lifetime: AbortController;
  closing?: Promise<void>;
}

/** Loopback virtual-port aliases select only an already registered owner/port. */
export class PreviewPortSockets {
  private readonly ports = new Map<string, Alias>();
  private sockets = 0;

  async reserve(port: number, owner: SocketAliasOwner, hostname = "127.0.0.1"): Promise<void> {
    if (isIP(hostname) !== 4 || !hostname.startsWith("127.")) throw new Error("Preview aliases require a loopback address");
    const key = `${hostname}:${port}`;
    let alias = this.ports.get(key);
    if (alias?.closing) { await alias.closing; return this.reserve(port, owner, hostname); }
    if (!alias) {
      if (this.ports.size >= 512) throw new Error("Preview socket alias limit");
      alias = this.listen(port, hostname);
      this.ports.set(key, alias);
    }
    alias.owners.add(owner);
    try { await alias.ready; }
    catch (error) { if (this.ports.get(key) === alias) this.ports.delete(key); throw error; }
  }
  async release(port: number, owner: SocketAliasOwner): Promise<void> {
    await Promise.all(Array.from(this.ports, ([key, alias]) => alias.port === port ? this.releaseAlias(key, alias, owner) : Promise.resolve()));
  }
  async releaseHost(hostname: string, owner: SocketAliasOwner): Promise<void> {
    await Promise.all(Array.from(this.ports, ([key, alias]) => alias.hostname === hostname ? this.releaseAlias(key, alias, owner) : Promise.resolve()));
  }
  private async releaseAlias(key: string, alias: Alias, owner: SocketAliasOwner): Promise<void> {
    if (!alias.owners.delete(owner)) { await alias.closing; return; }
    for (const [socket, authority] of alias.sockets) if (authority === owner) socket.destroy();
    if (alias.owners.size) return;
    alias.closing ??= (async () => {
      await alias.ready;
      alias.lifetime.abort();
      for (const socket of alias.sockets.keys()) socket.destroy();
      await new Promise<void>((resolve, reject) => alias.server.close(error => error ? reject(error) : resolve()));
      if (this.ports.get(key) === alias) this.ports.delete(key);
    })();
    await alias.closing;
  }
  async closeOwner(owner: SocketAliasOwner): Promise<void> {
    await Promise.all(Array.from(this.ports, ([key, alias]) => this.releaseAlias(key, alias, owner)));
  }

  private listen(port: number, hostname: string): Alias {
    const server = createServer((request, response) => {
      const authority = request.headers.host;
      const origin = request.headers.origin;
      const owner = origin && Array.from(alias.owners).find(owner => owner.ownsOrigin(origin));
      if (!aliasAuthority(port, authority, hostname) || !owner) { response.writeHead(403); response.end(); return; }
      const existing = alias.sockets.get(request.socket);
      if (existing && existing !== owner) { response.writeHead(421); response.end(); return; }
      alias.sockets.set(request.socket, owner);
      void dispatchPreviewHTTP(request, response, `http://${authority}`, { fetch: request => owner.fetchPort(port, request) }, alias.lifetime.signal, source => owner.ownsOrigin(source));
    });
    const alias: Alias = { hostname, port, server, owners: new Set(), sockets: new Map(), lifetime: new AbortController(), ready: new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(port, hostname, resolve);
    }) };
    server.on("connection", socket => {
      if (this.sockets >= 256 || alias.sockets.size >= 64) { socket.destroy(); return; }
      this.sockets++; alias.sockets.set(socket, null);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => { if (alias.sockets.delete(socket)) this.sockets--; });
    });
    server.on("upgrade", async (request, socket, head) => {
      const authority = request.headers.host;
      const origin = request.headers.origin;
      const path = request.url ?? "/";
      if (!aliasAuthority(port, authority, hostname) || !path.startsWith("/") || path.startsWith("//")) {
        socket.end("HTTP/1.1 421 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      const owner = origin && Array.from(alias.owners).find(owner => owner.ownsOrigin(origin));
      if (!owner) { socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      const existing = alias.sockets.get(socket);
      if (existing && existing !== owner) { socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      alias.sockets.set(socket, owner);
      try { if (!await owner.upgradePort(port, request, socket, head)) socket.destroy(); } catch { socket.destroy(); }
    });
    return alias;
  }
}


function aliasAuthority(port: number, authority: string | undefined, hostname: string): boolean {
  return authority === `${hostname}:${port}` || port === 80 && authority === hostname
    || hostname === "127.0.0.1" && (authority === `localhost:${port}` || port === 80 && authority === "localhost");
}
