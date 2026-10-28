import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { dispatchPreviewHTTP } from "../preview-origin-host";

export interface SocketAliasOwner {
  ownsOrigin(origin: string): boolean;
  fetchPort(port: number, request: Request): Promise<Response>;
  upgradePort(port: number, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
}
interface Alias {
  server: Server;
  owners: Set<SocketAliasOwner>;
  ready: Promise<void>;
  sockets: Map<Duplex, SocketAliasOwner | null>;
  lifetime: AbortController;
  closing?: Promise<void>;
}

/** Literal browser loopback WebSocket URLs select only an already registered owner/port. */
export class PreviewPortSockets {
  private readonly ports = new Map<number, Alias>();
  private sockets = 0;

  async reserve(port: number, owner: SocketAliasOwner): Promise<void> {
    let alias = this.ports.get(port);
    if (alias?.closing) { await alias.closing; return this.reserve(port, owner); }
    if (!alias) {
      if (this.ports.size >= 128) throw new Error("Preview socket alias limit");
      alias = this.listen(port);
      this.ports.set(port, alias);
    }
    alias.owners.add(owner);
    try { await alias.ready; }
    catch (error) { if (this.ports.get(port) === alias) this.ports.delete(port); throw error; }
  }
  async release(port: number, owner: SocketAliasOwner): Promise<void> {
    const alias = this.ports.get(port);
    if (!alias) return;
    alias.owners.delete(owner);
    for (const [socket, authority] of alias.sockets) if (authority === owner) socket.destroy();
    if (alias.owners.size) return;
    alias.closing ??= (async () => {
      await alias.ready;
      alias.lifetime.abort();
      for (const socket of alias.sockets.keys()) socket.destroy();
      await new Promise<void>((resolve, reject) => alias.server.close(error => error ? reject(error) : resolve()));
      if (this.ports.get(port) === alias) this.ports.delete(port);
    })();
    await alias.closing;
  }
  async closeOwner(owner: SocketAliasOwner): Promise<void> {
    await Promise.all(Array.from(this.ports.keys(), port => this.release(port, owner)));
  }

  private listen(port: number): Alias {
    const server = createServer((request, response) => {
      const authority = request.headers.host;
      const origin = request.headers.origin;
      const owner = origin && Array.from(alias.owners).find(owner => owner.ownsOrigin(origin));
      if (!aliasAuthority(port, authority) || !owner) { response.writeHead(403); response.end(); return; }
      const existing = alias.sockets.get(request.socket);
      if (existing && existing !== owner) { response.writeHead(421); response.end(); return; }
      alias.sockets.set(request.socket, owner);
      void dispatchPreviewHTTP(request, response, `http://${authority}`, { fetch: request => owner.fetchPort(port, request) }, alias.lifetime.signal, source => owner.ownsOrigin(source));
    });
    const alias: Alias = { server, owners: new Set(), sockets: new Map(), lifetime: new AbortController(), ready: new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(port, "127.0.0.1", resolve);
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
      if (!aliasAuthority(port, authority) || !path.startsWith("/") || path.startsWith("//")) {
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


function aliasAuthority(port: number, authority: string | undefined): boolean {
  return authority === `127.0.0.1:${port}` || authority === `localhost:${port}`
    || port === 80 && (authority === "127.0.0.1" || authority === "localhost");
}
