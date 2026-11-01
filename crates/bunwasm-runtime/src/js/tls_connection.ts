(function (internal: BunWasm.Tls.Internal) {
  "use strict";
  type Id = BunWasm.Tls.ConnectionId;
  type Peer = BunWasm.Tls.Peer;
  type Phase = { kind: "waiting" } | { kind: "handshaking" | "open"; id: Id } |
    { kind: "verifying"; id: Id; peer: Peer } | { kind: "closed" };
  type Write = { bytes: Uint8Array; accepted: number; committed: number; fence: number; done: BunWasm.Tls.Done };
  type Final = { kind: "queued"; done: BunWasm.Tls.Done } |
    { kind: "native"; done: BunWasm.Tls.Done; fence?: number } |
    { kind: "raw"; done: BunWasm.Tls.Done } | { kind: "done" };
  const BATCH = 65536;
  const RECORD = 16384;
  const EMPTY = new Uint8Array(0);
  function error(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
  function caught(value: unknown): Error { return value instanceof Error ? value : error("ERR_TLS_INTERNAL", "TLS operation failed"); }

  class TlsConnection implements BunWasm.Tls.Connection, BunWasm.Tls.TransferOwner {
    onData: ((bytes: Uint8Array) => void) | null = null;
    onEnd: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;
    onClose: (() => void) | null = null;
    canRead?: () => boolean;
    readCapacity?: () => number;
    drainingPlain = false;
    private phase: Phase = { kind: "waiting" };
    private raw: BunWasm.Tls.Raw | undefined;
    private reservation: BunWasm.Tls.Reservation;
    private waiter: BunWasm.Tls.Waiter;
    private generation = 0;
    private referenced: boolean;
    private input: Uint8Array = EMPTY;
    private inputCapacity = BATCH;
    private pendingPlaintext = 0;
    private output: { end: number; length: number } | undefined;
    private emitted = 0;
    private acknowledged = 0;
    private writing: Write | undefined;
    private final: Final | undefined;
    private eof: "none" | "received" | "delivered" = "none";
    private readClosed = false;
    private readNotified = false;
    private nativeWriteClosed = false;
    private peerInfo: Peer | undefined;
    private pumping = false;
    private reading = false;
    private options: BunWasm.Tls.DriverOptions;
    constructor(socket: BunWasm.Tls.Socket, options: BunWasm.Tls.DriverOptions) {
      this.options = options;
      this.referenced = socket._referenced;
      this.reservation = internal.require("tls_transport").reserve(socket, this);
      this.waiter = {
        ref: this.referenced, step: () => this.step(), fail: value => this.fail(caught(value)), cancel: () => this.destroy(),
      };
      try {
        internal.addIoWaiter(this.waiter);
        this.reservation.start((raw, unread) => this.activate(raw, unread));
      } catch (value) {
        this.destroy(caught(value));
        throw value;
      }
    }
    reserveRaw(raw: BunWasm.Tls.Raw): void { this.reservation.reserveRaw(raw); }
    connected(raw: BunWasm.Tls.Raw): void { this.reservation.connected(raw); }
    get handle(): number { return this.raw?.handle ?? -1; }
    get connecting(): boolean { return this.phase.kind === "waiting"; }
    get closed(): boolean { return this.phase.kind === "closed"; }
    get bufferedAmount(): number { return (this.writing ? this.writing.bytes.length - this.writing.committed : 0) + (this.output?.length ?? 0); }
    peer(): { address: string; port: number; family: string } {
      return this.raw?.peer() ?? { address: "", port: 0, family: "IPv4" };
    }
    inspect(): Peer | undefined { return this.peerInfo; }
    startReading(): void { this.reading = true; this.wake(); }
    readDemand(): void { this.wake(); }
    ref(value: boolean): void {
      this.referenced = value;
      this.reservation.ref(value);
      this.updateRefs();
    }
    private updateRefs(): void {
      const active = this.phase.kind === "waiting" || this.phase.kind === "handshaking" || this.phase.kind === "verifying" || Boolean(this.writing) || Boolean(this.final && this.final.kind !== "done");
      this.waiter.ref = this.referenced && (active || this.canProduce());
      this.raw?.ref(this.referenced && (active || this.canReceive()));
    }
    private wake(): void {
      if (this.closed) return;
      this.updateRefs();
      internal.native.wake?.(0);
    }
    private activate(raw: BunWasm.Tls.Raw, unread: Uint8Array): void {
      if (this.closed) return;
      this.raw = raw;
      this.input = unread;
      raw.canRead = () => this.canReceive();
      raw.readCapacity = () => Math.min(BATCH, this.inputCapacity);
      raw.onData = bytes => this.receive(bytes);
      raw.onEnd = () => { this.eof = "received"; this.wake(); };
      raw.onError = value => this.fail(value);
      raw.onClose = () => { if (!this.closed) this.fail(error("ECONNRESET", "TLS transport closed")); };
      try { this.allocate(); }
      catch (value) { this.fail(caught(value)); return; }
      if (this.closed) return;
      this.options.connected();
      if (this.closed) return;
      raw.startReading();
      this.wake();
    }
    private allocate(): void {
      const material = this.options.context();
      let context: ReturnType<BunWasm.Tls.Native["tlsCreateContext"]>;
      try { context = internal.native.tlsCreateContext(material); }
      finally { material.key?.fill(0); }
      try {
        const id = internal.native.tlsCreateConnection(context.id, this.options.connection);
        this.phase = { kind: "handshaking", id };
      } finally { internal.native.tlsRelease("context", context.id); }
      if (context.warning) this.options.warning(context.warning);
    }
    private canProduce(): boolean {
      return this.reading && this.phase.kind === "open" && !this.readClosed && (!this.canRead || this.canRead());
    }
    private canReceive(): boolean {
      if (this.closed || this.phase.kind === "waiting" || this.phase.kind === "verifying" || this.eof !== "none" || this.readClosed) return false;
      if (this.input.length || this.output || this.inputCapacity === 0) return false;
      return this.phase.kind === "handshaking" || this.canProduce() || this.pendingPlaintext > 0 || Boolean(this.final && this.final.kind !== "done");
    }
    private receive(bytes: Uint8Array): void {
      if (this.closed) return;
      if (this.input.length || bytes.length > BATCH) { this.fail(error("ERR_TLS_LIMIT", "TLS ingress limit exceeded")); return; }
      this.input = bytes;
      this.wake();
    }
    write(bytes: Uint8Array, callback: BunWasm.Tls.Done = () => {}): void {
      if (this.closed || this.final) { internal.nextTick(() => callback(error("ERR_TLS_WRITE_CLOSED", "TLS write side is closed"))); return; }
      if (this.writing) {
        const value = error("ERR_TLS_INVALID_STATE", "TLS supports one active stream write");
        internal.nextTick(() => callback(value));
        this.fail(value);
        return;
      }
      this.writing = { bytes, accepted: 0, committed: 0, fence: this.emitted, done: callback };
      this.wake();
    }
    shutdown(callback: BunWasm.Tls.Done): void {
      if (this.closed) { internal.nextTick(() => callback(error("ERR_STREAM_DESTROYED", "TLS connection is closed"))); return; }
      if (this.final) { internal.nextTick(() => callback(error("ERR_TLS_WRITE_CLOSED", "TLS shutdown already requested"))); return; }
      this.final = { kind: "queued", done: callback };
      this.wake();
    }
    private event(): BunWasm.Tls.Event {
      if (this.input.length) return { kind: "ciphertext", data: this.input };
      if (this.eof === "received") { this.eof = "delivered"; return { kind: "transport-eof" }; }
      if (this.phase.kind !== "open") return { kind: "poll" };
      const writing = this.writing;
      if (writing && this.pendingPlaintext === 0 && writing.accepted < writing.bytes.length) {
        return { kind: "plaintext", data: writing.bytes.subarray(writing.accepted, writing.accepted + RECORD) };
      }
      if (!writing && this.final?.kind === "queued") {
        this.final = { kind: "native", done: this.final.done };
        return { kind: "shutdown-write" };
      }
      return { kind: "poll" };
    }
    private step(): boolean | "progress" {
      if (this.closed) return true;
      if (this.phase.kind === "waiting" || this.phase.kind === "verifying" || this.output || this.pumping) return false;
      this.pumping = true;
      try { return this.pump(); }
      finally { this.pumping = false; this.updateRefs(); }
    }
    private pump(): boolean | "progress" {
      let progressed = false;
      let bytes = 0;
      for (let operations = 0; operations < 16 && bytes < 262144; operations++) {
        if (this.phase.kind === "closed") return true;
        if (this.phase.kind === "waiting" || this.phase.kind === "verifying" || this.output) return progressed ? "progress" : false;
        const event = this.event();
        const allowance = { plaintext: this.canProduce() ? Math.min(RECORD, this.readCapacity?.() ?? RECORD) : 0, ciphertext: BATCH };
        const result = internal.native.tlsStep(this.phase.id, event, allowance);
        const changed = this.apply(result, event, allowance.plaintext);
        bytes += result.acceptedCiphertext + result.consumedCiphertext + result.ciphertext.length + result.plaintext.length + result.committedPlaintext;
        progressed = changed || progressed;
        if (!changed) return progressed ? "progress" : false;
      }
      this.wake();
      return progressed ? "progress" : false;
    }
    private apply(result: BunWasm.Tls.Step, event: BunWasm.Tls.Event, readAllowance: number): boolean {
      const transitioned = this.readClosed !== result.readClosed || this.nativeWriteClosed !== result.writeClosed;
      this.account(result, event, readAllowance);
      if (result.kind === "failed") { this.fail(error(result.error.code, result.error.message)); return true; }
      if (result.kind === "verification-required") { this.verifyLater(result.peer); return true; }
      if (result.plaintext.length) this.onData?.(result.plaintext);
      if (this.closed) return true;
      if (result.readClosed && !this.readNotified) {
        this.readNotified = true;
        this.onEnd?.();
      }
      if (this.closed) return true;
      this.completeWrite();
      this.completeShutdown();
      if (result.kind === "closed" && this.final?.kind === "done" && this.readNotified) this.destroy();
      return result.acceptedCiphertext > 0 || result.consumedCiphertext > 0 || result.acceptedPlaintext > 0 || result.committedPlaintext > 0 || result.ciphertext.length > 0 || result.plaintext.length > 0 || transitioned;
    }
    private account(result: BunWasm.Tls.Step, event: BunWasm.Tls.Event, readAllowance: number): void {
      if (result.ciphertextStart !== this.emitted || result.ciphertextEnd !== this.emitted + result.ciphertext.length || result.ciphertext.length > BATCH || result.plaintext.length > readAllowance) throw error("ERR_TLS_INTERNAL", "Invalid TLS output accounting");
      if (result.acceptedCiphertext < 0 || result.acceptedCiphertext > (event.kind === "ciphertext" ? event.data.length : 0)) throw error("ERR_TLS_INTERNAL", "Invalid TLS ciphertext acceptance");
      if (result.acceptedPlaintext < 0 || result.acceptedPlaintext > (event.kind === "plaintext" ? event.data.length : 0)) throw error("ERR_TLS_INTERNAL", "Invalid TLS plaintext acceptance");
      if (result.inputCapacity < 0 || result.inputCapacity > BATCH || result.pendingPlaintext < 0 || result.pendingPlaintext > RECORD) throw error("ERR_TLS_INTERNAL", "Invalid TLS buffer accounting");
      if (result.plaintext.length && this.phase.kind !== "open") throw error("ERR_TLS_VERIFICATION_PENDING", "TLS plaintext preceded identity acceptance");
      this.input = this.input.subarray(result.acceptedCiphertext);
      this.inputCapacity = result.inputCapacity;
      this.pendingPlaintext = result.pendingPlaintext;
      this.readClosed = result.readClosed;
      this.nativeWriteClosed = result.writeClosed;
      this.accountWrite(result);
      if (this.final?.kind === "native" && result.shutdownCiphertextEnd !== undefined) this.final.fence = result.shutdownCiphertextEnd;
      this.emitted = result.ciphertextEnd;
      if (result.ciphertext.length) this.send(result.ciphertext, result.ciphertextEnd);
    }
    private accountWrite(result: BunWasm.Tls.Step): void {
      const writing = this.writing;
      if (!writing) {
        if (result.acceptedPlaintext || result.committedPlaintext) throw error("ERR_TLS_INTERNAL", "TLS committed unowned plaintext");
        return;
      }
      writing.accepted += result.acceptedPlaintext;
      writing.committed += result.committedPlaintext;
      if (writing.accepted > writing.bytes.length || writing.committed > writing.accepted) throw error("ERR_TLS_INTERNAL", "Invalid TLS write commitment");
      if (result.committedPlaintext && result.writeCiphertextEnd === undefined) throw error("ERR_TLS_INTERNAL", "TLS write has no ciphertext fence");
      if (result.writeCiphertextEnd !== undefined) writing.fence = Math.max(writing.fence, result.writeCiphertextEnd);
    }
    private send(bytes: Uint8Array, end: number): void {
      const raw = this.raw;
      if (!raw) throw error("ERR_TLS_INTERNAL", "TLS has no raw transport");
      this.output = { end, length: bytes.length };
      const generation = this.generation;
      raw.write(bytes, value => {
        if (this.generation !== generation || this.closed) return;
        if (value) { this.fail(value); return; }
        this.output = undefined;
        this.acknowledged = end;
        this.completeWrite();
        this.completeShutdown();
        this.wake();
      });
    }
    private completeWrite(): void {
      if (this.phase.kind !== "open") return;
      const writing = this.writing;
      if (!writing || writing.committed !== writing.bytes.length || writing.accepted !== writing.bytes.length || this.acknowledged < writing.fence) return;
      this.writing = undefined;
      internal.nextTick(() => writing.done());
    }
    private completeShutdown(): void {
      const final = this.final;
      if (this.closed || final?.kind !== "native" || !this.nativeWriteClosed || final.fence === undefined || this.acknowledged < final.fence || !this.raw) return;
      this.final = { kind: "raw", done: final.done };
      const generation = this.generation;
      this.raw.shutdown(value => {
        if (this.generation !== generation || this.closed) return;
        if (value) { this.fail(value); return; }
        this.final = { kind: "done" };
        final.done();
        if (this.readNotified) this.destroy();
      });
    }
    private verifyLater(peer: Peer): void {
      if (this.phase.kind !== "handshaking") throw error("ERR_TLS_INVALID_STATE", "TLS identity report repeated");
      const id = this.phase.id;
      this.phase = { kind: "verifying", id, peer };
      const generation = this.generation;
      internal.nextTick(() => {
        if (this.generation !== generation || this.phase.kind !== "verifying") return;
        try { this.verify(id, peer, generation); }
        catch (value) { this.fail(caught(value)); }
      });
    }
    private verify(id: Id, peer: Peer, generation: number): void {
      const decision = this.options.verify(peer);
      if (this.generation !== generation || this.closed) return;
      const rejected = Boolean(decision.error && this.options.connection.rejectUnauthorized);
      internal.native.tlsAcceptIdentity(id, rejected ? { accepted: false, code: "ERR_TLS_CERT_ALTNAME_INVALID" } : { accepted: true });
      if (rejected) { this.fail(decision.error ?? error("ERR_TLS_CERTIFICATE", "TLS peer rejected")); return; }
      const inspected = internal.native.tlsInspect(id, "peer");
      this.peerInfo = inspected.peer;
      this.phase = { kind: "open", id };
      this.options.secure(inspected.peer, decision.authorized && inspected.authorized, decision.error);
      if (!this.closed) this.wake();
    }
    private fail(value: Error): void {
      if (this.closed) return;
      this.destroy(value);
    }
    private finishDestroy(value: Error | undefined, writeError: Error, writing: Write | undefined, final: Final | undefined): void {
      if (writing) internal.nextTick(() => writing.done(writeError));
      if (final && final.kind !== "done") internal.nextTick(() => final.done(writeError));
      try { if (value) this.onError?.(value); }
      finally { this.onClose?.(); }
    }
    destroy(value?: Error): void {
      if (this.closed) return;
      const phase = this.phase;
      this.phase = { kind: "closed" };
      this.generation++;
      internal.removeIoWaiter(this.waiter);
      const writing = this.writing;
      const final = this.final;
      this.writing = undefined;
      this.final = undefined;
      this.input = EMPTY;
      this.output = undefined;
      const writeError = value ?? error("ERR_STREAM_DESTROYED", "TLS connection is closed");
      try {
        if (phase.kind !== "waiting" && phase.kind !== "closed") internal.native.tlsRelease("connection", phase.id);
      } finally {
        try { this.reservation.destroy(value); }
        finally { this.finishDestroy(value, writeError, writing, final); }
      }
    }
  }
  return TlsConnection satisfies BunWasm.Tls.DriverConstructor;
})
