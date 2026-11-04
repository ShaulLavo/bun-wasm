declare namespace BunWasm.Tls {
  type ContextId = number & { readonly __brand: "TlsContextId" };
  type ConnectionId = number & { readonly __brand: "TlsConnectionId" };
  type Version = "TLSv1.2" | "TLSv1.3";
  type Done = (error?: Error | null) => void;
  type Wait = "ciphertext" | "output" | "read-allowance" | "identity" | "poll";
  type Event = { kind: "poll" | "transport-eof" | "shutdown-write" } | { kind: "ciphertext" | "plaintext"; data: Uint8Array };
  interface ContextOptions { minVersion: Version; maxVersion: Version; ca?: readonly Uint8Array[]; cert?: Uint8Array; key?: Uint8Array }
  interface ConnectionOptions { servername?: string; alpn: Uint8Array; rejectUnauthorized: boolean }
  interface Peer {
    protocol: string; cipher: string; alpn: Uint8Array | false; verifyResult: number;
    chainVerified: boolean; authorizationError: string | false; certificates: Uint8Array[];
  }
  interface Accounting {
    acceptedCiphertext: number; consumedCiphertext: number; acceptedPlaintext: number; committedPlaintext: number;
    pendingPlaintext: number; ciphertext: Uint8Array; plaintext: Uint8Array;
    ciphertextStart: number; ciphertextEnd: number; writeCiphertextEnd?: number; shutdownCiphertextEnd?: number;
    inputCapacity: number; readClosed: boolean; writeClosed: boolean;
  }
  type Step = Accounting & (
    { kind: "progress" | "wait"; wait: Wait } |
    { kind: "verification-required"; peer: Peer } |
    { kind: "failed"; error: { code: string; message: string; libraryCodes: readonly number[] } } |
    { kind: "closed" }
  );
  interface Native {
    tlsCreateContext(options: ContextOptions): { id: ContextId; warning: string | false };
    tlsCreateConnection(id: ContextId, options: ConnectionOptions): ConnectionId;
    tlsStep(id: ConnectionId, event: Event, allowance: { plaintext: number; ciphertext: number }): Step;
    tlsAcceptIdentity(id: ConnectionId, decision: { accepted: boolean; code?: string }): void;
    tlsInspect(id: ConnectionId, requested: "peer"): { peer: Peer; authorized: boolean; authorizationError: string | false };
    tlsRelease(kind: "context", id: ContextId): unknown;
    tlsRelease(kind: "connection", id: ConnectionId): unknown;
    hostWrite(handle: number, bytes: Uint8Array): number;
    wake?(timeout: number): void;
  }
  interface Waiter {
    ref: boolean;
    step(): boolean | "progress";
    fail(error: unknown): void;
    cancel(): void;
  }
  interface Raw {
    handle: number; closed: boolean; readEnded: boolean; reading: boolean; referenced?: boolean;
    reader: Waiter | null; writer: Waiter | null; ownership: Ownership;
    onData: ((bytes: Uint8Array) => void) | null; onEnd: (() => void) | null;
    onError: ((error: Error) => void) | null; onClose: (() => void) | null;
    canRead?: () => boolean; readCapacity?: () => number;
    startReading(): void; write(bytes: Uint8Array, callback?: Done): void;
    shutdown(callback: Done): void; destroy(error?: Error): void; ref(value: boolean): void;
    peer(): { address: string; port: number; family: string };
  }
  type OwnershipState = { kind: "plain"; epoch: number } |
    { kind: "reserved" | "tls"; epoch: number; owner: TransferOwner } | { kind: "closed"; epoch: number };
  interface Ownership {
    state: OwnershipState; dispatchDepth: number;
    valid(epoch: number): boolean;
    dispatch(callback: () => void): void;
    afterDispatch(callback: () => void): void;
    close(): void;
  }
  interface TransferOwner {
    drainingPlain: boolean;
    reserveRaw(raw: Raw): void;
    connected(raw: Raw): void;
    destroy(error?: Error): void;
  }
  interface ReadBuffer { shift(): unknown; length: number }
  interface Socket {
    _conn: Raw | Connection | null; _phase: string; _referenced: boolean; _readReady: boolean;
    _tlsOwner?: TransferOwner; _tlsTransferred?: boolean; _tlsTarget?: { host: string; port: number }; _unixPath?: string;
    _pendingWrite: unknown; _pendingFinal: unknown; _connecting: Waiter | null;
    _onread?: unknown; _timeoutTimer?: number;
    _readableState: { buffer: ReadBuffer; length: number; flowing?: boolean | null; decoder?: unknown; encoding?: unknown };
    destroyed: boolean; closed: boolean; connecting: boolean; writableLength: number; writableEnded: boolean;
    readable: boolean; writable: boolean; readableLength: number;
    bytesRead: number; bytesWritten: number; allowHalfOpen: boolean;
    remoteAddress?: string; remotePort?: number; remoteFamily?: string;
    _attach(connection: Connection): void; _touch(): void; _updatePeer(): void;
    _useSignal(signal: AbortSignal): void; _closeHadError: boolean;
    _destroy(error: Error | null, callback: Done): void;
    _tlsFence(callback: Done): void; _tlsClose(): void;
    connect(...args: unknown[]): Socket;
    read(size?: number): unknown; unshift(chunk: unknown): void; pause(): Socket; resume(): Socket;
    push(chunk: unknown): boolean; write(chunk: unknown, encoding?: unknown, callback?: Done): boolean;
    end(...args: unknown[]): Socket; destroy(error?: Error): Socket;
    emit(event: string, ...args: unknown[]): boolean;
    once(event: string, callback: (...args: never[]) => void): Socket;
    on(event: string, callback: (...args: never[]) => void): Socket;
    removeListener(event: string, callback: (...args: never[]) => void): Socket;
    ref(): Socket; unref(): Socket;
  }
  interface SocketConstructor { new(options?: object): Socket; prototype: Socket }
  interface Reservation {
    readonly target: { host: string; port: number } | undefined;
    start(ready: (raw: Raw, unread: Uint8Array) => void): void;
    reserveRaw(raw: Raw): void;
    connected(raw: Raw): void;
    destroy(error?: Error): void;
    ref(value: boolean): void;
  }
  interface Transport {
    track(raw: Raw): Ownership;
    reserve(socket: Socket, owner: TransferOwner): Reservation;
    guard(socket: Socket): void;
    unshift(socket: Socket, chunk: unknown, push: (value: unknown) => void): void;
  }
  interface DriverOptions {
    context(): ContextOptions; connection: ConnectionOptions;
    verify(peer: Peer): BunWasm.TlsIdentityDecision;
    secure(peer: Peer, authorized: boolean, error?: Error): void;
    warning(message: string): void;
    connected(): void;
  }
  interface Connection {
    readonly handle: number; readonly connecting: boolean; readonly closed: boolean; readonly bufferedAmount: number;
    canRead?: () => boolean; readCapacity?: () => number;
    onData: ((bytes: Uint8Array) => void) | null; onEnd: (() => void) | null;
    onError: ((error: Error) => void) | null; onClose: (() => void) | null;
    startReading(): void; write(bytes: Uint8Array, callback?: Done): void; shutdown(callback: Done): void;
    destroy(error?: Error): void; ref(value: boolean): void;
    peer(): { address: string; port: number; family: string };
    inspect(): Peer | undefined;
  }
  interface DriverConstructor { new(socket: Socket, options: DriverOptions): Connection }
  interface SecureContext { readonly context: object }
  interface Certificate extends BunWasm.TlsPeerCertificate {
    raw?: Uint8Array;
    issuerCertificate?: Certificate;
    [key: string]: unknown;
  }
  type Identity = BunWasm.TlsIdentity;
  interface X509 { toLegacyObject(): Certificate; readonly raw: Uint8Array }
  interface Crypto {
    X509Certificate: new(bytes: Uint8Array) => X509;
    createPrivateKey(options: { key: Uint8Array; passphrase: string | Uint8Array }): { export(options: { format: "pem"; type: "pkcs8" }): string | Uint8Array };
  }
  interface Internal {
    native: Native;
    nextTick(callback: () => void): void;
    realTimers: { setImmediate(callback: () => void): unknown; clearImmediate(handle: unknown): void };
    addIoWaiter<W extends Waiter>(waiter: W): W;
    removeIoWaiter(waiter: Waiter): void;
    require(name: "net"): { hostError(handle: number, message: string): Error };
    require(name: "tls_transport"): Transport;
    require(name: "tls_connection"): DriverConstructor;
    require(name: "tls_identity"): Identity;
    require(name: "net_hostname"): (hostname: string) => string;
    require(name: "net_address"): { port(value: unknown): number; isIP(host: string): number };
    require(name: "buffer"): { Buffer: BunWasm.BufferConstructor };
    builtin(name: "node:net"): { Socket: SocketConstructor };
    builtin(name: "node:crypto"): Crypto;
  }
}
