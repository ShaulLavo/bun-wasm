import { afterEach, expect, test } from "bun:test";
import { adapter, type TlsSocket } from "../tests/fixtures/tls-client/adapter";

let active: ReturnType<typeof adapter> | undefined;
afterEach(() => { active?.cleanup(); active = undefined; });
function fixture() { active = adapter(); return active; }
function open(options: object = {}): { state: ReturnType<typeof adapter>; socket: TlsSocket } {
  const state = fixture();
  state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, ...options });
  socket.on("error", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  return { state, socket };
}
function codes(value: unknown): object { return expect.objectContaining({ code: value }); }

test("adapter opens only after a single deferred identity callback and keeps pg startup queued", () => {
  const state = fixture();
  state.handshake();
  let checks = 0;
  let secured = 0;
  const socket = state.tls.connect({ host: "fixture.test", port: 443, checkServerIdentity(host: string) {
    expect(state.state.insideNative).toBe(false);
    expect(host).toBe("fixture.test");
    expect(state.writes).toHaveLength(0);
    checks++;
  } }, () => secured++);
  socket.on("error", () => {});
  let written = 0;
  socket.write("pg startup", () => written++);
  expect(state.contexts).toHaveLength(0);
  state.pump(); state.callbacks(); state.pump();
  expect(checks).toBe(0);
  expect(state.calls.filter(call => call.event.kind === "plaintext")).toHaveLength(0);
  state.callbacks();
  expect(checks).toBe(1);
  expect(secured).toBe(1);
  state.pump();
  expect(written).toBe(0);
  state.callbacks();
  expect(written).toBe(1);
  expect(Buffer.concat(state.writes).toString()).toBe("pg startup");
  state.pump(5); state.callbacks();
  expect(checks).toBe(1);
  expect(socket).toBeInstanceOf(state.net.Socket);
  expect(socket.encrypted).toBe(true);
  expect(socket.authorized).toBe(true);
});

test("adapter accepts positional connect overloads and calls back on secureConnect", () => {
  const state = fixture(); state.handshake();
  let callback = 0;
  const socket = state.tls.connect(443, "fixture.test", { servername: "fixture.test", ALPNProtocols: ["h2", "http/1.1"] }, () => callback++);
  socket.on("error", () => {});
  expect(callback).toBe(0);
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(callback).toBe(1);
  expect(socket.servername).toBe("fixture.test");
  expect(socket.getProtocol()).toBe("TLSv1.3");
  expect(socket.getCipher()).toEqual({ name: "TLS_AES_128_GCM_SHA256" });
  expect(socket.getPeerCertificate()).toMatchObject({ subjectaltname: "DNS:fixture.test" });
  expect(socket.getPeerX509Certificate()).toBeDefined();
});

test("adapter does not imply low-level SNI from the destination", () => {
  const { socket } = open();
  expect(socket.servername).toBe(false);
});

test("adapter preserves a wrapped socket's original IP target without IP SNI", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain();
  raw._tlsTarget = { host: "192.0.2.8", port: 5432 };
  let checked = "";
  const socket = state.tls.connect({ socket: raw, checkServerIdentity(host: string) { checked = host; } });
  socket.on("error", () => {});
  state.callbacks(); state.pump(); state.callbacks();
  expect(checked).toBe("192.0.2.8");
  expect(socket.servername).toBe(false);
});

test("adapter's custom verifier cannot turn a failed chain into authorized", () => {
  const state = fixture(); state.handshake();
  state.state.peer.chainVerified = false;
  state.state.peer.verifyResult = 18;
  state.state.peer.authorizationError = "DEPTH_ZERO_SELF_SIGNED_CERT";
  let called = 0;
  const socket = state.tls.connect({ host: "fixture.test", port: 443, checkServerIdentity() { called++; } });
  const errors: Error[] = [];
  socket.on("error", value => errors.push(value));
  socket.write("startup", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(called).toBe(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  expect(socket.authorized).toBe(false);
  expect(state.calls.filter(call => call.event.kind === "plaintext")).toHaveLength(0);
});

test("adapter report-only mode opens with truthful chain authorization state", () => {
  const state = fixture(); state.handshake();
  state.state.peer.chainVerified = false;
  state.state.peer.authorizationError = "CERT_HAS_EXPIRED";
  const socket = state.tls.connect({ host: "fixture.test", port: 443, rejectUnauthorized: false });
  socket.on("error", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(socket.authorized).toBe(false);
  expect(socket.authorizationError).toBe("CERT_HAS_EXPIRED");
  expect(socket.secureConnecting).toBe(false);
});

test("adapter report-only hostname failure remains unauthorized", () => {
  const mismatch = Object.assign(new Error("name mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  const { socket } = open({ rejectUnauthorized: false, checkServerIdentity() { return mismatch; } });
  expect(socket.authorized).toBe(false);
  expect(socket.authorizationError).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
});

test("adapter makes destroy inside identity verification terminal", () => {
  const state = fixture(); state.handshake();
  let socket: TlsSocket;
  let secure = 0;
  socket = state.tls.connect({ host: "fixture.test", port: 443, checkServerIdentity() { socket.destroy(); } });
  socket.on("error", () => {}); socket.on("secureConnect", () => secure++);
  socket.write("startup", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks(); state.pump();
  expect(socket.destroyed).toBe(true);
  expect(state.decisions).toHaveLength(0);
  expect(secure).toBe(0);
  expect(state.calls.filter(call => call.event.kind === "plaintext")).toHaveLength(0);
  expect(state.releases.filter(([kind]) => kind === "connection")).toHaveLength(1);
});

test("adapter reports callback exceptions and invalid returns once", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, checkServerIdentity() { return false; } });
  const errors: Error[] = [];
  socket.on("error", value => errors.push(value));
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  expect(state.decisions).toEqual([{ accepted: false, code: "ERR_INVALID_ARG_TYPE" }]);
});

test("adapter snapshots secure contexts without retaining native context IDs", () => {
  const state = fixture(); state.handshake();
  const ca = Buffer.from("CA");
  const key = Buffer.from("KEY");
  const cert = Buffer.from("CERT");
  const context = state.tls.createSecureContext({ ca: [ca], key, cert, minVersion: "TLSv1.2" });
  expect(Object.isFrozen(context)).toBe(true);
  expect(state.releases.filter(([kind]) => kind === "context")).toHaveLength(1);
  ca.fill(0); key.fill(0); cert.fill(0);
  const socket = state.tls.connect({ host: "fixture.test", port: 443, secureContext: context });
  socket.on("error", () => {});
  state.pump(); state.callbacks();
  expect(state.contexts[1]).toMatchObject({ ca: [new Uint8Array([67, 65])], cert: new Uint8Array([67, 69, 82, 84]), key: new Uint8Array([75, 69, 89]) });
  expect(state.releases.filter(([kind]) => kind === "context")).toHaveLength(2);
});

test("adapter decrypts passphrase keys after socket reservation and clears transient bytes", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain();
  const socket = state.tls.connect({ socket: raw, cert: "CERT", key: "ENCRYPTED KEY", passphrase: "test-only" });
  socket.on("error", () => {});
  expect(raw._tlsTransferred).toBe(true);
  expect(state.counters.decryptedKeys).toBe(0);
  state.callbacks();
  expect(state.counters.decryptedKeys).toBe(1);
  expect(state.contexts[0]).toMatchObject({ key: new TextEncoder().encode("DECRYPTED KEY") });
});

for (const options of [
  { pfx: "unsupported" }, { ciphers: "unsupported" }, { session: new Uint8Array(0) }, { isServer: true },
  { rejectUnauthorized: "false" }, { rejectUnauthorized: 0 }, { rejectUnauthorized: null }, { rejectUnauthorized: "" }, { ALPNProtocols: ["x".repeat(256)] }, { ALPNProtocols: new Uint8Array([4, 97]) },
  { minVersion: "TLSv1" }, { minVersion: "TLSv1.3", maxVersion: "TLSv1.2" }, { signal: {} },
  { highWaterMark: -1 }, { writableHighWaterMark: 1048577 }, { checkServerIdentity: false }, { cert: "CERT" },
]) {
  test(`adapter rejects invalid options before opening a host handle ${Object.keys(options).join(",")}`, () => {
    const state = fixture();
    expect(() => state.tls.connect({ host: "fixture.test", port: 443, ...options })).toThrow();
    expect(state.counters.opens).toBe(0);
    expect(state.contexts).toHaveLength(0);
  });
}

test("adapter rejects arbitrary wrapping and unsupported server and root operations explicitly", () => {
  const state = fixture();
  expect(() => state.tls.connect({ socket: {} })).toThrow(codes("ERR_TLS_NOT_SUPPORTED"));
  expect(() => state.tls.createServer()).toThrow(codes("ERR_TLS_NOT_SUPPORTED"));
  expect(() => state.tls.rootCertificates).toThrow(codes("ERR_TLS_NOT_SUPPORTED"));
});

test("adapter AbortSignal cancellation releases native and host ownership once", () => {
  const state = fixture();
  const controller = new AbortController();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, signal: controller.signal });
  const errors: Error[] = [];
  socket.on("error", value => errors.push(value));
  state.pump(); state.callbacks();
  controller.abort("adapter"); state.callbacks(); state.pump();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "ABORT_ERR", cause: "adapter" });
  expect(state.counters.closes).toBe(1);
  expect(state.releases.filter(([kind]) => kind === "connection")).toHaveLength(1);
});

test("adapter high-water marks retain stream write pressure", () => {
  const { state, socket } = open({ highWaterMark: 4 });
  state.state.credit = 0;
  let completed = 0;
  expect(socket.write("abcdefgh", () => completed++)).toBe(false);
  state.pump(); state.callbacks();
  expect(completed).toBe(0);
  expect(socket.writableLength).toBe(8);
  state.state.credit = 8;
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(completed).toBe(1);
  expect(socket.writableLength).toBe(0);
});

test("adapter handshake timeout is owned, cancellable, and follows socket ref state", () => {
  const state = fixture();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, handshakeTimeout: 50 });
  const errors: Error[] = [];
  socket.on("error", value => errors.push(value));
  expect(state.timers.size).toBe(1);
  socket.unref();
  expect(Array.from(state.timers).every(timer => !timer.referenced)).toBe(true);
  socket.ref();
  expect(Array.from(state.timers).every(timer => timer.referenced)).toBe(true);
  state.expireTimers(); state.callbacks();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "ERR_TLS_HANDSHAKE_TIMEOUT" });
  expect(state.counters.closes).toBe(1);
});

test("adapter successful verification removes the handshake timeout", () => {
  const { state, socket } = open({ handshakeTimeout: 50 });
  expect(socket.authorized).toBe(true);
  expect(state.timers.size).toBe(0);
});

test("adapter exposes the exact native option fields and releases its temporary context", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, servername: "fixture.test", ALPNProtocols: ["h2"], ca: [], minVersion: "TLSv1.3" });
  socket.on("error", () => {});
  state.pump(); state.callbacks();
  expect(state.contexts).toEqual([{ ca: [], minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }]);
  expect(state.connectionOptions).toEqual([{ servername: "fixture.test", alpn: new Uint8Array([2, 104, 50]), rejectUnauthorized: true }]);
  expect(state.releases).toEqual([["context", 1]]);
});

test("adapter copies public certificate data rather than exposing cached mutable peer bytes", () => {
  const { socket } = open();
  const first = socket.getPeerCertificate();
  first.subjectaltname = "DNS:changed.invalid";
  expect(socket.getPeerCertificate().subjectaltname).toBe("DNS:fixture.test");
});

test("adapter refuses plaintext HTTPS servers through both factory entry points", () => {
  const state = fixture();
  const httpFactory = Reflect.get(state.runtimeNet, "nodeHttp");
  const https = Reflect.apply(httpFactory, state.runtimeNet, ["https:"]);
  if (typeof https !== "object" || https === null) throw new Error("Missing HTTPS factory");
  const createServer = Reflect.get(https, "createServer");
  const Server = Reflect.get(https, "Server");
  expect(() => Reflect.apply(createServer, https, [])).toThrow(codes("ERR_TLS_NOT_SUPPORTED"));
  expect(() => Reflect.construct(Server, [])).toThrow(codes("ERR_TLS_NOT_SUPPORTED"));
  expect(state.counters.opens).toBe(0);
});

test("adapter connect callback keeps the EventEmitter socket receiver", () => {
  const state = fixture(); state.handshake();
  let called = 0;
  const socket = state.tls.connect(443, "fixture.test", function (this: unknown) { expect(this).toBe(socket); called++; });
  socket.on("error", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(called).toBe(1);
});

test("adapter retains a native certificate failure without claiming verification completed", () => {
  const state = fixture();
  state.respond(() => ({ kind: "failed", error: { code: "CERT_HAS_EXPIRED", message: "adapter expired chain", libraryCodes: [] } }));
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); socket.on("error", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(socket.authorized).toBe(false);
  expect(socket.authorizationError).toBe("CERT_HAS_EXPIRED");
  expect(socket.getProtocol()).toBeNull();
});

test("adapter rejects oversized material and lists before native or raw allocation", () => {
  const state = fixture();
  for (const options of [
    { ca: new Uint8Array(1048577) },
    { key: "x".repeat(1048577), cert: "CERT" },
    { ca: Array<string>(1025).fill("") },
    { ALPNProtocols: Array<string>(32768).fill("x") },
  ]) expect(() => state.tls.connect({ host: "fixture.test", port: 443, ...options })).toThrow();
  expect(state.counters.opens).toBe(0);
  expect(state.contexts).toHaveLength(0);
});

test("adapter module enumeration does not invoke the unavailable root-list operation", () => {
  const state = fixture();
  const namespace: Record<string, unknown> = {};
  for (const key of Object.keys(state.tls)) namespace[key] = Reflect.get(state.tls, key);
  expect(namespace.connect).toBe(state.tls.connect);
  expect(namespace.TLSSocket).toBe(state.tls.TLSSocket);
  expect(() => state.tls.rootCertificates).toThrow(codes("ERR_TLS_NOT_SUPPORTED"));
  expect(state.contexts).toHaveLength(0);
});

test("adapter keeps even an empty early write callback behind identity acceptance", () => {
  const state = fixture();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); socket.on("error", () => {});
  let callbacks = 0; socket.write("", () => callbacks++);
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(callbacks).toBe(0);
  state.handshake(); state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(callbacks).toBe(1);
  expect(socket.authorized).toBe(true);
});

for (const behavior of ["throws", "invalid-return"]) {
  test(`adapter honors an identity rejection under explicit opt-out when its callback ${behavior}`, () => {
    const state = fixture(); state.handshake();
    const socket = state.tls.connect({ host: "fixture.test", port: 443, rejectUnauthorized: false, checkServerIdentity() {
      if (behavior === "throws") throw new Error("adapter callback failure");
      return false;
    } });
    const errors: Error[] = [];
    socket.on("error", value => errors.push(value));
    let secured = 0; socket.on("secureConnect", () => secured++);
    socket.write("startup", () => {});
    state.pump(); state.callbacks(); state.pump(); state.callbacks();
    expect(errors).toHaveLength(1);
    expect(secured).toBe(0);
    expect(socket.destroyed).toBe(true);
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({ accepted: false });
    expect(state.calls.filter(call => call.event.kind === "plaintext")).toHaveLength(0);
  });
}
