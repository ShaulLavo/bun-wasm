(function () {
  interface Socket {
    destroyed: boolean;
    readable: boolean;
    writable: boolean;
    on(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
    destroy(): unknown;
    ref(): unknown;
    unref(): unknown;
    setTimeout(ms: number): unknown;
    setKeepAlive(enable: boolean, delay: number): unknown;
  }
  type Options = { keepAlive?: boolean; keepAliveMsecs?: number; maxFreeSockets?: number; timeout?: number };
  type Owned = { key: string; state: "active" | "idle"; cleanup: () => void };
  class SocketPool {
    readonly sockets: Record<string, Socket[]> = Object.create(null);
    readonly freeSockets: Record<string, Socket[]> = Object.create(null);
    private owned = new Map<Socket, Owned>();
    private options: Options;
    constructor(options: Options) { this.options = options; }
    get size(): number { return this.owned.size; }
    take(key: string): Socket | undefined {
      const free = this.freeSockets[key];
      while (free?.length) {
        const socket = free[free.length - 1];
        this.removeFrom(this.freeSockets, key, socket);
        if (socket.destroyed || !socket.readable || !socket.writable) { this.forget(socket); socket.destroy(); continue; }
        const entry = this.owned.get(socket);
        if (!entry) continue;
        entry.state = "active";
        this.addTo(this.sockets, key, socket);
        socket.ref();
        socket.setTimeout(0);
        return socket;
      }
      return undefined;
    }
    track(key: string, socket: Socket): void {
      const close = () => this.forget(socket);
      const guard = () => { if (this.owned.get(socket)?.state === "idle") socket.destroy(); };
      socket.on("close", close);
      socket.on("error", guard);
      socket.on("end", guard);
      socket.on("data", guard);
      socket.on("timeout", guard);
      this.owned.set(socket, { key, state: "active", cleanup: () => {
        socket.removeListener("close", close);
        for (const event of ["error", "end", "data", "timeout"]) socket.removeListener(event, guard);
      } });
      this.addTo(this.sockets, key, socket);
    }
    release(socket: Socket, reusable: boolean): void {
      const entry = this.owned.get(socket);
      if (!entry) { socket.destroy(); return; }
      const count = this.freeSockets[entry.key]?.length || 0;
      if (!reusable || !this.options.keepAlive || socket.destroyed || !socket.readable || !socket.writable || count >= (this.options.maxFreeSockets ?? 256)) {
        this.forget(socket);
        socket.destroy();
        return;
      }
      this.removeFrom(this.sockets, entry.key, socket);
      entry.state = "idle";
      this.addTo(this.freeSockets, entry.key, socket);
      socket.setKeepAlive(true, this.options.keepAliveMsecs ?? 1000);
      socket.setTimeout(this.options.timeout ?? 0);
      socket.unref();
    }
    forget(socket: Socket): void {
      const entry = this.owned.get(socket);
      if (!entry) return;
      entry.cleanup();
      this.owned.delete(socket);
      this.removeFrom(this.sockets, entry.key, socket);
      this.removeFrom(this.freeSockets, entry.key, socket);
    }
    destroy(): void {
      for (const socket of Array.from(this.owned.keys())) {
        this.forget(socket);
        socket.destroy();
      }
    }
    private addTo(table: Record<string, Socket[]>, key: string, socket: Socket): void {
      (table[key] ||= []).push(socket);
    }
    private removeFrom(table: Record<string, Socket[]>, key: string, socket: Socket): void {
      const sockets = table[key];
      if (!sockets) return;
      const index = sockets.indexOf(socket);
      if (index !== -1) sockets.splice(index, 1);
      if (!sockets.length) delete table[key];
    }
  }
  function responseKeepsAlive(version: string, connection: string | undefined): boolean {
    const tokens = (connection || "").toLowerCase().split(",").map(value => value.trim());
    return !tokens.includes("close") && (version === "1.1" || tokens.includes("keep-alive"));
  }
  return { SocketPool, responseKeepsAlive };
})
