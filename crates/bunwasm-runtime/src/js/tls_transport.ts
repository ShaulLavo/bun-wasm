(function (internal: BunWasm.Tls.Internal) {
  "use strict";
  type Raw = BunWasm.Tls.Raw;
  type Socket = BunWasm.Tls.Socket;
  type Owner = BunWasm.Tls.TransferOwner;
  const MAX_UNREAD = 65536;

  function ownershipError(message = "Socket ownership has transferred to TLS"): Error {
    return Object.assign(new Error(message), { code: "ERR_TLS_SOCKET_OWNERSHIP" });
  }
  function guard(socket: Socket): void {
    if (socket._tlsTransferred) throw ownershipError();
  }
  function unshift(socket: Socket, chunk: unknown, push: (value: unknown) => void): void {
    const raw = rawOf(socket);
    if (!raw?.ownership.dispatchDepth) { guard(socket); push(chunk); return; }
    const state = socket._readableState;
    const flowing = state.flowing;
    state.flowing = false;
    try { push(chunk); }
    finally { if (!socket._tlsTransferred) state.flowing = flowing; }
  }
  function failure(error: unknown): Error {
    return error instanceof Error ? error : new Error("TLS transport failed");
  }
  function track(raw: Raw): BunWasm.Tls.Ownership {
    let afterDispatch: (() => void) | undefined;
    const ownership: BunWasm.Tls.Ownership = {
      state: { kind: "plain", epoch: 0 }, dispatchDepth: 0,
      valid(epoch) { return this.state.epoch === epoch && this.state.kind !== "closed" && this.state.kind !== "reserved"; },
      dispatch(callback) {
        this.dispatchDepth++;
        try { callback(); }
        finally {
          this.dispatchDepth--;
          if (this.dispatchDepth === 0 && afterDispatch) finishDispatch();
        }
      },
      afterDispatch(callback) {
        if (this.dispatchDepth === 0) internal.nextTick(callback);
        else afterDispatch = callback;
      },
      close() {
        if (this.state.kind === "closed") return;
        this.state = { kind: "closed", epoch: this.state.epoch + 1 };
        afterDispatch = undefined;
        internal.removeIoWaiter(participant);
      },
    };
    const participant = internal.addIoWaiter({
      ref: false, step: () => raw.closed, fail: (error: unknown) => cancel(failure(error)), cancel: () => cancel(),
    });
    function finishDispatch(): void {
      const callback = afterDispatch;
      afterDispatch = undefined;
      if (callback) internal.nextTick(callback);
    }
    function cancel(error?: Error): void {
      const state = ownership.state;
      if (state.kind === "closed") return;
      if (state.kind === "plain") raw.destroy(error);
      else state.owner.destroy(error);
    }
    return ownership;
  }
  function rawOf(socket: Socket): Raw | undefined {
    const raw = socket._conn;
    if (!raw) return undefined;
    if (!("ownership" in raw)) throw ownershipError("Socket is not a plain bun-wasm transport");
    return raw;
  }
  function unread(socket: Socket): Uint8Array {
    const state = socket._readableState;
    if (state.decoder || state.encoding) throw ownershipError("Cannot wrap a socket with decoded plaintext input");
    if (state.length > MAX_UNREAD) throw Object.assign(new Error("TLS unread input limit exceeded"), { code: "ERR_TLS_LIMIT" });
    const bytes = new Uint8Array(state.length);
    let offset = 0;
    while (state.buffer.length) {
      const chunk = state.buffer.shift();
      if (!(chunk instanceof Uint8Array) || offset + chunk.length > bytes.length) throw ownershipError("Invalid unread socket bytes");
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    state.length = 0;
    if (offset !== bytes.length) throw ownershipError("Invalid unread socket length");
    return bytes;
  }
  class Reservation implements BunWasm.Tls.Reservation {
    readonly target: { host: string; port: number } | undefined;
    private raw: Raw | undefined;
    private previousClose: (() => void) | null = null;
    private ready: ((raw: Raw, unread: Uint8Array) => void) | undefined;
    private state: "reserved" | "active" | "closed" = "reserved";
    private unwound = false;
    private fenced = false;
    private referenced: boolean;
    private socket: Socket;
    private owner: Owner;
    constructor(socket: Socket, owner: Owner) {
      this.socket = socket;
      this.owner = owner;
      guard(socket);
      if (socket.destroyed || socket._unixPath !== undefined || socket._onread) throw ownershipError("TLS requires a live TCP socket with binary stream input");
      if (socket._phase !== "open" && socket._phase !== "connecting") throw ownershipError("Socket is not connected or connecting");
      if (socket.writableEnded || socket._pendingFinal) throw ownershipError("Cannot wrap a socket with a pending plaintext final");
      if (socket.connecting && (socket.writableLength || socket._pendingWrite)) throw ownershipError("Cannot wrap a connecting socket with pending plaintext writes");
      if (socket._readableState.decoder || socket._readableState.encoding) throw ownershipError("TLS requires binary socket input");
      const raw = rawOf(socket);
      if (raw && raw.ownership.state.kind !== "plain") throw ownershipError();
      this.target = socket._tlsTarget;
      this.referenced = socket._referenced;
      socket._tlsTransferred = true;
      socket._tlsOwner = owner;
      socket._readReady = false;
      socket._readableState.flowing = false;
      clearTimeout(socket._timeoutTimer);
      if (raw) this.reserveRaw(raw);
    }
    reserveRaw(raw: Raw): void {
      if (this.state === "closed") { raw.destroy(); return; }
      if (this.raw === raw) return;
      if (this.raw || raw.ownership.state.kind !== "plain") throw ownershipError();
      this.raw = raw;
      this.previousClose = raw.onClose;
      raw.ownership.state = { kind: "reserved", epoch: raw.ownership.state.epoch + 1, owner: this.owner };
      if (raw.reader) internal.removeIoWaiter(raw.reader);
      raw.reader = null;
      raw.reading = false;
      raw.onData = raw.onEnd = raw.onError = raw.onClose = null;
      raw.onError = error => this.owner.destroy(error);
      raw.onClose = () => this.owner.destroy();
    }
    connected(raw: Raw): void {
      this.reserveRaw(raw);
      this.socket._phase = "open";
      this.beginFence();
    }
    start(ready: (raw: Raw, unread: Uint8Array) => void): void {
      this.ready = ready;
      if (this.raw) this.raw.ownership.afterDispatch(() => this.afterUnwind());
      else internal.nextTick(() => this.afterUnwind());
      if (!this.socket.connecting) this.beginFence();
    }
    private beginFence(): void {
      if (this.state !== "reserved" || this.owner.drainingPlain) return;
      this.owner.drainingPlain = true;
      this.socket._tlsFence(error => {
        this.owner.drainingPlain = false;
        if (this.state !== "reserved") return;
        if (error) { this.owner.destroy(error); return; }
        this.fenced = true;
        this.activate();
      });
    }
    private afterUnwind(): void {
      if (this.state !== "reserved") return;
      this.unwound = true;
      this.activate();
    }
    private activate(): void {
      if (this.state !== "reserved" || !this.unwound || !this.fenced || !this.ready || !this.raw) return;
      const raw = this.raw;
      let input: Uint8Array;
      try { input = unread(this.socket); }
      catch (error) { this.owner.destroy(failure(error)); return; }
      this.state = "active";
      raw.ownership.state = { kind: "tls", epoch: raw.ownership.state.epoch + 1, owner: this.owner };
      raw.canRead = undefined;
      raw.readCapacity = undefined;
      raw.ref(this.referenced);
      this.ready(raw, input);
    }
    ref(value: boolean): void {
      this.referenced = value;
      this.socket._referenced = value;
      if (this.socket._connecting) this.socket._connecting.ref = value;
      this.raw?.ref(value);
    }
    destroy(error?: Error): void {
      if (this.state === "closed") return;
      this.state = "closed";
      this.ready = undefined;
      this.owner.drainingPlain = false;
      if (this.socket._connecting) internal.removeIoWaiter(this.socket._connecting);
      this.socket._connecting = null;
      const raw = this.raw ?? rawOf(this.socket);
      if (raw) {
        raw.onData = raw.onEnd = raw.onError = raw.onClose = null;
        raw.destroy(error);
      }
      this.socket._conn = null;
      this.socket._phase = "closed";
      this.socket._tlsClose();
      const previousClose = this.previousClose;
      this.previousClose = null;
      previousClose?.();
    }
  }
  function reserve(socket: Socket, owner: Owner): BunWasm.Tls.Reservation {
    return new Reservation(socket, owner);
  }
  return { track, reserve, guard, unshift } satisfies BunWasm.Tls.Transport;
})
