(function (internal: BunWasm.Tls.Internal) {
  "use strict";
  type Options = Record<string, unknown>;
  type Context = BunWasm.Tls.ContextOptions;
  type Peer = BunWasm.Tls.Peer;
  type Certificate = BunWasm.Tls.Certificate;
  type CheckIdentity = BunWasm.TlsCheckServerIdentity;
  type Snapshot = { material: Context; passphrase?: string | Uint8Array };
  const { Socket } = internal.builtin("node:net");
  const { Buffer } = internal.require("buffer");
  const identity = internal.require("tls_identity");
  const contexts = new WeakMap<object, Snapshot>();
  const MAX_MATERIAL = 1048576;
  const unsupportedOptions = ["pfx", "session", "sessionIdContext", "ticketKeys", "pskCallback", "pskIdentityHint", "dhparam", "ciphers", "sigalgs", "ecdhCurve", "secureProtocol", "secureOptions", "clientCertEngine", "privateKeyEngine", "privateKeyIdentifier", "SNICallback", "ALPNCallback", "requestOCSP", "enableTrace", "requestCert", "honorCipherOrder", "crl", "allowPartialTrustChain", "allowLegacyRenegotiation", "enableSSLRenegotiation", "useSystemCA", "useOpenSSLCA", "useBundledCA", "fd", "path"];
  const authorizationCodes = new Set(["CERT_NOT_YET_VALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_CHAIN_TOO_LONG", "CERT_REVOKED", "INVALID_CA", "INVALID_PURPOSE", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERTIFICATE", "ERR_TLS_HOSTNAME_REQUIRED", "ERR_TLS_IDENTITY_CALLBACK"]);
  const securityFields = ["ca", "cert", "key", "passphrase", "minVersion", "maxVersion"];

  function failure(code: string, message: string, Ctor: ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor = Error): Error {
    return Object.assign(new Ctor(message), { code });
  }
  function invalid(name: string): Error { return failure("ERR_INVALID_ARG_TYPE", `The "${name}" option has an invalid type`, TypeError); }
  function unsupported(name: string): never { throw failure("ERR_TLS_OPTION_NOT_SUPPORTED", `TLS option "${name}" is not supported in bun-wasm`); }
  function notSupported(): never { throw failure("ERR_TLS_NOT_SUPPORTED", "This TLS operation is not supported in bun-wasm"); }
  function record(value: unknown): Options {
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("options");
    const result: Options = {};
    for (const [key, entry] of Object.entries(value)) result[key] = entry;
    return result;
  }
  function bytes(value: unknown, name: string, limit = MAX_MATERIAL): Uint8Array {
    const length = typeof value === "string" ? value.length : value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? value.byteLength : undefined;
    if (length === undefined) throw invalid(name);
    if (length > limit) throw failure("ERR_TLS_LIMIT", `TLS ${name} exceeds its byte limit`);
    let result: Uint8Array;
    if (typeof value === "string") result = Buffer.from(value);
    else if (value instanceof ArrayBuffer) result = new Uint8Array(value.slice(0));
    else if (ArrayBuffer.isView(value)) result = new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    else throw invalid(name);
    if (result.length > limit) throw failure("ERR_TLS_LIMIT", `TLS ${name} exceeds its byte limit`);
    return result;
  }
  function version(value: unknown, fallback: BunWasm.Tls.Version): BunWasm.Tls.Version {
    if (value === undefined) return fallback;
    if (value === "TLSv1.2" || value === "TLSv1.3") return value;
    throw failure("ERR_TLS_INVALID_PROTOCOL_VERSION", "TLS versions must be TLSv1.2 or TLSv1.3", TypeError);
  }
  function validateOptions(options: Options): void {
    for (const name of unsupportedOptions) if (options[name] !== undefined) unsupported(name);
    if (options.isServer === true) unsupported("isServer");
    for (const name of ["rejectUnauthorized", "allowHalfOpen", "isServer"]) if (options[name] !== undefined && typeof options[name] !== "boolean") throw invalid(name);
    for (const name of ["host", "servername"]) if (options[name] !== undefined && typeof options[name] !== "string") throw invalid(name);
    for (const name of ["highWaterMark", "readableHighWaterMark", "writableHighWaterMark"]) validateWatermark(options, name);
    if (options.checkServerIdentity !== undefined && typeof options.checkServerIdentity !== "function") throw invalid("checkServerIdentity");
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw invalid("signal");
    if (options.handshakeTimeout !== undefined && (typeof options.handshakeTimeout !== "number" || !Number.isFinite(options.handshakeTimeout) || options.handshakeTimeout < 0)) throw invalid("handshakeTimeout");
    if (options.socket !== undefined && !(options.socket instanceof Socket)) throw failure("ERR_TLS_NOT_SUPPORTED", "TLS can wrap only a bun-wasm net.Socket", TypeError);
    if (options.onread !== undefined) unsupported("onread");
    if (options.objectMode || options.readableObjectMode || options.writableObjectMode) throw invalid("objectMode");
  }
  function validateWatermark(options: Options, name: string): void {
    const value = options[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MATERIAL)) throw failure("ERR_OUT_OF_RANGE", `TLS ${name} must be between 0 and ${MAX_MATERIAL}`, RangeError);
  }
  function snapshot(options: Options): Snapshot {
    const minVersion = version(options.minVersion, "TLSv1.2");
    const maxVersion = version(options.maxVersion, "TLSv1.3");
    if (minVersion === "TLSv1.3" && maxVersion === "TLSv1.2") throw failure("ERR_TLS_INVALID_PROTOCOL_VERSION", "TLS minimum version exceeds maximum version");
    const material: Context = { minVersion, maxVersion };
    if (options.ca !== undefined) {
      const list: unknown[] = Array.isArray(options.ca) ? options.ca : [options.ca];
      if (list.length > 1024) throw failure("ERR_TLS_LIMIT", "TLS CA list exceeds 1024 entries");
      let size = 0;
      material.ca = list.map(value => {
        const entry = bytes(value, "ca", MAX_MATERIAL - size);
        size += entry.length;
        return entry;
      });
    }
    if (Array.isArray(options.cert) || Array.isArray(options.key)) unsupported("multiple client identities");
    if (options.cert !== undefined) material.cert = bytes(options.cert, "cert");
    if (options.key !== undefined) material.key = bytes(options.key, "key");
    if (Boolean(material.cert) !== Boolean(material.key)) throw failure("ERR_TLS_INVALID_CONTEXT", "TLS client certificate and key must be supplied together");
    if (options.passphrase === undefined) return { material };
    if (!material.key) throw failure("ERR_TLS_INVALID_CONTEXT", "TLS passphrase requires a private key");
    if (typeof options.passphrase === "string") return { material, passphrase: options.passphrase };
    return { material, passphrase: bytes(options.passphrase, "passphrase") };
  }
  function copyMaterial(config: Snapshot): Context {
    const original = config.material;
    const material: Context = { minVersion: original.minVersion, maxVersion: original.maxVersion };
    if (original.ca) material.ca = original.ca.map(value => value.slice());
    if (original.cert) material.cert = original.cert.slice();
    if (original.key) material.key = original.key.slice();
    if (material.key && config.passphrase !== undefined) {
      const key = internal.builtin("node:crypto").createPrivateKey({ key: material.key, passphrase: config.passphrase });
      material.key.fill(0);
      material.key = bytes(key.export({ format: "pem", type: "pkcs8" }), "key");
    }
    return material;
  }
  function warning(message: string): void { process.emitWarning?.(message, "Warning", "BUNWASM_EXTRA_CA_CERTS"); }
  function validateContext(config: Snapshot): void {
    const material = copyMaterial(config);
    try {
      const context = internal.native.tlsCreateContext(material);
      try { if (context.warning) warning(context.warning); }
      finally { internal.native.tlsRelease("context", context.id); }
    } finally { material.key?.fill(0); }
  }
  function createSecureContext(input?: unknown): BunWasm.Tls.SecureContext {
    const options = record(input);
    validateOptions(options);
    const config = snapshot(options);
    validateContext(config);
    const context = Object.freeze({});
    const result = Object.freeze({ context });
    contexts.set(result, config);
    return result;
  }
  function contextFor(options: Options): Snapshot {
    if (options.secureContext === undefined) return snapshot(options);
    const supplied = options.secureContext;
    if (supplied === null || typeof supplied !== "object" || !contexts.has(supplied)) throw invalid("secureContext");
    for (const field of securityFields) if (options[field] !== undefined) throw failure("ERR_TLS_INVALID_CONTEXT", `TLS ${field} cannot override a secureContext`);
    const config = contexts.get(supplied);
    if (!config) throw invalid("secureContext");
    return config;
  }
  function alpn(value: unknown): Uint8Array {
    if (value === undefined) return new Uint8Array(0);
    if (!Array.isArray(value)) return validateAlpn(bytes(value, "ALPNProtocols", 65535));
    if (value.length > 32767) throw failure("ERR_TLS_ALPN_INVALID", "ALPN list exceeds 32767 names");
    let size = 0;
    const protocols = value.map((entry: unknown) => {
      if (typeof entry !== "string") throw invalid("ALPNProtocols");
      const encoded = bytes(entry, "ALPNProtocols", 255);
      if (!encoded.length || encoded.length > 255) throw failure("ERR_TLS_ALPN_INVALID", "ALPN names must contain between 1 and 255 bytes");
      size += encoded.length + 1;
      if (size > 65535) throw failure("ERR_TLS_ALPN_INVALID", "ALPN list exceeds 65535 bytes");
      return encoded;
    });
    const encoded = new Uint8Array(size);
    let offset = 0;
    for (const protocol of protocols) {
      encoded[offset++] = protocol.length;
      encoded.set(protocol, offset);
      offset += protocol.length;
    }
    return encoded;
  }
  function validateAlpn(encoded: Uint8Array): Uint8Array {
    if (encoded.length > 65535) throw failure("ERR_TLS_ALPN_INVALID", "ALPN list exceeds 65535 bytes");
    for (let offset = 0; offset < encoded.length;) {
      const length = encoded[offset++];
      if (!length || offset + length > encoded.length) throw failure("ERR_TLS_ALPN_INVALID", "Invalid ALPN wire encoding");
      offset += length;
    }
    return encoded;
  }
  function legacy(peer: Peer, detailed = false): Certificate {
    const crypto = internal.builtin("node:crypto");
    const certificates = peer.certificates;
    const leaf = certificates[0];
    if (!leaf) return {};
    const result = new crypto.X509Certificate(leaf).toLegacyObject();
    if (!detailed) return result;
    let previous = result;
    for (const der of certificates.slice(1)) {
      const certificate = new crypto.X509Certificate(der).toLegacyObject();
      previous.issuerCertificate = certificate;
      previous = certificate;
    }
    return result;
  }
  function checker(options: Options): CheckIdentity | undefined {
    const selected = options.checkServerIdentity;
    if (selected === undefined) return undefined;
    if (typeof selected !== "function") throw invalid("checkServerIdentity");
    return (host, certificate) => selected(host, certificate);
  }
  function args(input: unknown[]): { options: Options; callback?: () => void } {
    const values = input.slice();
    let callback: (() => void) | undefined;
    const last = values[values.length - 1];
    if (typeof last === "function") { values.pop(); callback = function (this: unknown) { Reflect.apply(last, this, []); }; }
    if (!values.length) throw failure("ERR_MISSING_ARGS", "TLS connection options are required", TypeError);
    const first = values.shift();
    if (first !== null && typeof first === "object") {
      if (values.length) throw invalid("options");
      return { options: record(first), callback };
    }
    const options: Options = { port: first };
    if (typeof values[0] === "string") options.host = values.shift();
    if (values.length) Object.assign(options, record(values.shift()));
    if (values.length) throw invalid("options");
    return { options, callback };
  }
  class TLSSocket extends Socket {
    readonly encrypted = true;
    authorized = false;
    authorizationError: string | null = null;
    servername: string | false = false;
    alpnProtocol: string | false = false;
    private tls: BunWasm.Tls.Connection | undefined;
    private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    private secure = false;
    constructor(socket?: unknown, input?: unknown) {
      const options = record(input);
      if (socket !== undefined) options.socket = socket;
      validateOptions(options);
      const config = contextFor(options);
      const wireAlpn = alpn(options.ALPNProtocols);
      const check = checker(options);
      const supplied = options.socket;
      const original = supplied instanceof Socket ? supplied._tlsTarget : undefined;
      const connectHost = typeof options.host === "string" ? options.host : supplied ? undefined : "localhost";
      const target = identity.selectTarget({
        ...(typeof options.servername === "string" ? { servername: options.servername } : {}),
        ...(connectHost === undefined ? {} : { connectHost }),
        ...(original === undefined ? {} : { originalTarget: original.host }),
        rejectUnauthorized: options.rejectUnauthorized !== false,
      });
      if (target instanceof Error) throw target;
      const connectOptions = Object.assign({}, options);
      delete connectOptions.signal;
      if (!supplied) connectOptions.port = internal.require("net_address").port(options.port);
      super({ allowHalfOpen: options.allowHalfOpen, highWaterMark: options.highWaterMark, readableHighWaterMark: options.readableHighWaterMark ?? options.highWaterMark, writableHighWaterMark: options.writableHighWaterMark ?? options.highWaterMark });
      this.servername = target.servername || false;
      let rawSocket: BunWasm.Tls.Socket;
      if (supplied instanceof Socket) rawSocket = supplied;
      else {
        rawSocket = new Socket();
        rawSocket.connect(connectOptions);
      }
      const connecting = rawSocket.connecting;
      this._referenced = rawSocket._referenced;
      const Driver = internal.require("tls_connection");
      const driverOptions: BunWasm.Tls.DriverOptions = {
        context: () => copyMaterial(config),
        connection: { servername: target.servername, alpn: wireAlpn, rejectUnauthorized: options.rejectUnauthorized !== false },
        verify: peer => this.verifyPeer(peer, target, options.rejectUnauthorized !== false, check),
        secure: (peer, authorized, value) => this.accept(peer, authorized, value),
        connected: () => { this._updatePeer(); if (connecting) this.emit("connect"); },
        warning,
      };
      try {
        this.tls = new Driver(rawSocket, driverOptions);
        this._attach(this.tls);
      } catch (value) {
        if (!supplied) rawSocket.destroy();
        throw value;
      }
      if (options.signal instanceof AbortSignal) this._useSignal(options.signal);
      if (typeof options.handshakeTimeout === "number" && options.handshakeTimeout > 0) this.handshakeTimer = setTimeout(() => this.destroy(failure("ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timed out")), options.handshakeTimeout);
      if (!this._referenced) this.timerRef(false);
    }
    get connecting(): boolean { return this.tls?.connecting ?? false; }
    connect(): this { throw failure("ERR_TLS_SOCKET_OWNERSHIP", "TLSSocket already owns its connection"); }
    private verifyPeer(peer: Peer, target: BunWasm.TlsIdentityTarget, rejectUnauthorized: boolean, check?: CheckIdentity): BunWasm.TlsIdentityDecision {
      const decision = peer.chainVerified
        ? identity.verifyIdentity({
          chainVerified: true, cert: legacy(peer), target, rejectUnauthorized,
          ...(check === undefined ? {} : { checkServerIdentity: check }),
        })
        : identity.verifyIdentity({
          chainVerified: false,
          authorizationError: failure(peer.authorizationError || "ERR_TLS_CERTIFICATE", "TLS certificate chain verification failed"),
          rejectUnauthorized,
        });
      if (decision.kind !== "authorized") this.authorizationError = code(decision.authorizationError);
      return decision;
    }
    private accept(peer: Peer, authorized: boolean, value?: Error): void {
      if (this.destroyed) return;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.authorized = authorized;
      this.authorizationError = value ? code(value) : peer.authorizationError || null;
      this.alpnProtocol = peer.alpn === false ? false : Buffer.from(peer.alpn).toString("utf8");
      this.secure = true;
      this.emit("secureConnect");
    }
    _destroy(value: Error | null, callback: BunWasm.Tls.Done): void {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this._closeHadError = Boolean(value);
      if (!this.secure && value && "code" in value && typeof value.code === "string" && authorizationCodes.has(value.code)) this.authorizationError = value.code;
      super._destroy(value, callback);
    }
    ref(): this { super.ref(); this.timerRef(true); return this; }
    unref(): this { super.unref(); this.timerRef(false); return this; }
    private timerRef(referenced: boolean): void {
      const timer: unknown = this.handshakeTimer;
      if (typeof timer !== "object" || timer === null) return;
      if (referenced && "ref" in timer && typeof timer.ref === "function") timer.ref();
      if (!referenced && "unref" in timer && typeof timer.unref === "function") timer.unref();
    }
    getProtocol(): string | null { return this.tls?.inspect()?.protocol ?? null; }
    getCipher(): { name: string } | undefined { const peer = this.tls?.inspect(); return peer ? { name: peer.cipher } : undefined; }
    getPeerCertificate(detailed = false): Certificate { const peer = this.tls?.inspect(); return peer ? legacy(peer, detailed) : {}; }
    getPeerX509Certificate(): BunWasm.Tls.X509 | undefined {
      const leaf = this.tls?.inspect()?.certificates[0];
      return leaf ? new (internal.builtin("node:crypto").X509Certificate)(leaf) : undefined;
    }
    get secureConnecting(): boolean { return !this.secure && !this.destroyed; }
    renegotiate(): never { return notSupported(); }
    setServername(): never { return notSupported(); }
    setSession(): never { return notSupported(); }
    getSession(): never { return notSupported(); }
    getTLSTicket(): never { return notSupported(); }
    exportKeyingMaterial(): never { return notSupported(); }
    getFinished(): never { return notSupported(); }
    getPeerFinished(): never { return notSupported(); }
    enableTrace(): never { return notSupported(); }
  }
  function code(value: Error): string {
    if ("code" in value && typeof value.code === "string") return value.code;
    return "ERR_TLS_IDENTITY_CALLBACK";
  }
  function connect(...input: unknown[]): TLSSocket {
    const parsed = args(input);
    const socket = new TLSSocket(parsed.options.socket, parsed.options);
    if (parsed.callback) socket.once("secureConnect", parsed.callback);
    return socket;
  }
  const module = {
    TLSSocket, connect, createConnection: connect, createSecureContext,
    checkServerIdentity: identity.checkServerIdentity,
    createServer: notSupported, Server: class Server { constructor() { notSupported(); } },
    DEFAULT_MIN_VERSION: "TLSv1.2", DEFAULT_MAX_VERSION: "TLSv1.3", DEFAULT_ECDH_CURVE: "auto",
  };
  Object.defineProperty(module, "rootCertificates", { get: notSupported });
  return module;
})
