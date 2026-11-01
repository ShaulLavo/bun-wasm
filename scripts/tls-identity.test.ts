import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isRecord, loadIdentity, parseCertificate } from "./fixtures/tls-identity/load.ts";

type IdentityCase = {
  readonly name: string;
  readonly hostname: unknown;
  readonly cert: BunWasm.TlsPeerCertificate;
  readonly valid: boolean;
  readonly throws: string | undefined;
};
type UpstreamCase = { readonly name: string; readonly hostname: unknown; readonly cert: BunWasm.TlsPeerCertificate; readonly reason: string | undefined };

function parseCases(value: unknown): IdentityCase[] {
  if (!Array.isArray(value)) throw new Error("identity fixture must be an array");
  return value.map(parseCase);
}

function parseCase(item: unknown): IdentityCase {
  if (!isRecord(item) || typeof item.name !== "string" || typeof item.hostname !== "string") throw new Error("invalid identity fixture case");
  if (typeof item.valid !== "boolean" && typeof item.throws !== "string") throw new Error(`fixture case ${item.name} needs valid or throws`);
  return { name: item.name, hostname: item.hostname, cert: parseCertificate(item.cert), valid: item.valid === true, throws: typeof item.throws === "string" ? item.throws : undefined };
}

function parseUpstream(value: unknown): UpstreamCase[] {
  if (!Array.isArray(value)) throw new Error("upstream identity fixture must be an array");
  return value.map(item => {
    if (!isRecord(item) || typeof item.name !== "string") throw new Error("invalid upstream identity fixture case");
    if (item.reason !== undefined && typeof item.reason !== "string") throw new Error("invalid upstream reason");
    return { name: item.name, hostname: item.hostname, cert: parseCertificate(item.cert), reason: item.reason };
  });
}

function thrownCode(callback: () => unknown): string | undefined {
  try { callback(); } catch (error) { return isRecord(error) && typeof error.code === "string" ? error.code : undefined; }
  return undefined;
}

const identity = loadIdentity();
const cases = parseCases(JSON.parse(readFileSync(new URL("./fixtures/tls-identity/additional-cases.json", import.meta.url), "utf8")));
const upstream = parseUpstream(JSON.parse(readFileSync(new URL("./fixtures/tls-identity/upstream-cases.json", import.meta.url), "utf8")));

for (const item of upstream) test(`pinned Node identity ${item.name}`, () => {
  const error = identity.checkServerIdentity(item.hostname, item.cert);
  expect(error?.reason).toBe(item.reason?.replace("Host: \n", "Host: \\u000a"));
});

test("the pinned selection retains every pure upstream case", () => {
  expect(upstream.length).toBe(59);
  expect(upstream.map(item => item.name)).toEqual(Array.from({ length: 59 }, (_, index) => `upstream-${index}`));
});

test("additional identity cases preserve valid and invalid decisions in both runtime emission modes", () => {
  for (const module of [identity, loadIdentity(true)]) for (const item of cases) checkCase(module, item);
});

function checkCase(module: BunWasm.TlsIdentity, item: IdentityCase): void {
  if (item.throws !== undefined) {
    expect(thrownCode(() => module.checkServerIdentity(item.hostname, item.cert)), item.name).toBe(item.throws);
    return;
  }
  const result = module.checkServerIdentity(item.hostname, item.cert);
  expect(result === undefined, item.name).toBe(item.valid);
  if (result !== undefined) expect(result.code, item.name).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
}

test("identity target selection keeps SNI separate from verification identity", () => {
  expect(identity.selectTarget({ servername: "secure.example", connectHost: "relay.invalid", originalTarget: "original.invalid", rejectUnauthorized: true })).toEqual({ kind: "dns", hostname: "secure.example", servername: "secure.example" });
  expect(identity.selectTarget({ servername: "", connectHost: "secure.example", originalTarget: "original.invalid", rejectUnauthorized: true })).toEqual({ kind: "dns", hostname: "secure.example", servername: "" });
  expect(identity.selectTarget({ connectHost: "2001:DB8:0:0:0:0:0:1", rejectUnauthorized: true })).toEqual({ kind: "ip", hostname: "2001:DB8:0:0:0:0:0:1", servername: "" });
  expect(identity.selectTarget({ originalTarget: "secure.example", rejectUnauthorized: true })).toEqual({ kind: "dns", hostname: "secure.example", servername: "" });
  expect(identity.selectTarget({ servername: "192.0.2.1", connectHost: "secure.example", rejectUnauthorized: true })).toEqual({ kind: "ip", hostname: "192.0.2.1", servername: "" });
});

test("missing and malformed expected identities fail at the selection boundary", () => {
  expect(identity.selectTarget({ rejectUnauthorized: true })).toMatchObject({ code: "ERR_TLS_HOSTNAME_REQUIRED" });
  expect(identity.selectTarget({ connectHost: "", originalTarget: "original.example", rejectUnauthorized: true })).toMatchObject({ code: "ERR_TLS_HOSTNAME_REQUIRED" });
  expect(identity.selectTarget({ rejectUnauthorized: false })).toEqual({ kind: "none", hostname: undefined, servername: "" });
  for (const servername of ["bad/name", "bad\0name", "a..example", "a".repeat(64) + ".example", "測試/example", "測試%2fexample", "[::1]", "name:443", "name\\x", "name\n", ".", "a.example..", "name#part"]) {
    expect(identity.selectTarget({ servername, rejectUnauthorized: true }), JSON.stringify(servername)).toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  }
});

test("IDNA conversion keeps the callback hostname and validates SNI separately", () => {
  expect(identity.selectTarget({ servername: "測試.example", rejectUnauthorized: true })).toEqual({ kind: "dns", hostname: "測試.example", servername: "xn--g6w251d.example" });
  expect(identity.selectTarget({ servername: "", connectHost: "測試.example", rejectUnauthorized: true })).toEqual({ kind: "dns", hostname: "測試.example", servername: "" });
});

test("failed native chains cannot reach custom JS identity policy", () => {
  const error = Object.assign(new Error("chain verification failed"), { code: "CERT_HAS_EXPIRED" });
  expect(identity.verifyIdentity({ chainVerified: false, authorizationError: error, rejectUnauthorized: true })).toEqual({ kind: "rejected", authorizationError: error });
  expect(identity.verifyIdentity({ chainVerified: false, authorizationError: error, rejectUnauthorized: false })).toEqual({ kind: "unauthorized", authorizationError: error });
  let calls = 0;
  const failed = { chainVerified: false, authorizationError: error, rejectUnauthorized: false } satisfies BunWasm.TlsIdentityVerification;
  const extraCallback = Object.assign({}, failed, { checkServerIdentity() { calls++; return undefined; } });
  expect(identity.verifyIdentity(extraCallback)).toEqual({ kind: "unauthorized", authorizationError: error });
  expect(calls).toBe(0);
});

test("custom identity policy runs once after chain success and can replace hostname matching", () => {
  let calls = 0;
  const cert = { subjectaltname: "DNS:other.example" };
  const result = identity.verifyIdentity({ chainVerified: true, target: { kind: "dns", hostname: "secure.example", servername: "" }, cert, rejectUnauthorized: true,
    checkServerIdentity(hostname, peer) { calls++; expect(hostname).toBe("secure.example"); expect(peer).toBe(cert); return undefined; },
  });
  expect(result).toEqual({ kind: "authorized" });
  expect(calls).toBe(1);
});

test("custom identity errors, throws, and explicit verification opt-out remain distinct", () => {
  const error = new Error("custom identity mismatch");
  const request = { chainVerified: true, target: { kind: "dns", hostname: "secure.example", servername: "" }, cert: {}, rejectUnauthorized: true } satisfies BunWasm.TlsIdentityVerification;
  expect(identity.verifyIdentity({ ...request, checkServerIdentity: () => error })).toEqual({ kind: "rejected", authorizationError: error });
  expect(identity.verifyIdentity({ ...request, rejectUnauthorized: false, checkServerIdentity: () => error })).toEqual({ kind: "unauthorized", authorizationError: error });
  expect(identity.verifyIdentity({ ...request, rejectUnauthorized: false, checkServerIdentity() { throw error; } })).toEqual({ kind: "rejected", authorizationError: error });
  expect(identity.verifyIdentity({ ...request, checkServerIdentity() { throw "private callback detail"; } })).toMatchObject({ kind: "rejected", authorizationError: { code: "ERR_INVALID_ARG_TYPE", message: "checkServerIdentity threw a non-Error value" } });
});

test("missing identity and certificate mismatch never become authorized in report-only mode", () => {
  expect(identity.verifyIdentity({ chainVerified: true, target: { kind: "none", hostname: undefined, servername: "" }, cert: {}, rejectUnauthorized: false })).toMatchObject({ kind: "unauthorized", authorizationError: { code: "ERR_TLS_HOSTNAME_REQUIRED" } });
  expect(identity.verifyIdentity({ chainVerified: true, target: { kind: "dns", hostname: "secure.example", servername: "" }, cert: {}, rejectUnauthorized: false })).toMatchObject({ kind: "unauthorized", authorizationError: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });
  expect(identity.verifyIdentity({ chainVerified: true, target: { kind: "dns", hostname: "secure.example", servername: "" }, cert: {}, rejectUnauthorized: true })).toMatchObject({ kind: "rejected" });
});

test("identity diagnostics are bounded, escaped, and do not attach the certificate", () => {
  const cert = { subjectaltname: "DNS:" + "a".repeat(4000) };
  const error = identity.checkServerIdentity("name\0" + "a".repeat(4000), cert);
  expect(error?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  expect(error?.message.length).toBeLessThan(650);
  expect(error?.message).not.toContain("\0");
  expect(error).not.toHaveProperty("cert");
  expect(error).not.toHaveProperty("raw");
});


test("IP comparison rejects malformed text and normalizes embedded IPv4 without cross-family matches", () => {
  expect(identity.checkServerIdentity("::ffff:192.0.2.128", { subjectaltname: "IP Address:0:0:0:0:0:ffff:c000:280" })).toBeUndefined();
  expect(identity.checkServerIdentity("192.0.2.128", { subjectaltname: "IP Address:::ffff:192.0.2.128" })).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  for (const value of ["127.0.0.1\n", "127.0.0.1\0", "01.2.3.4", "127.1", "::1\n", "[::1]", "::1/128", "2001:db8:::1"]) {
    expect(identity.checkServerIdentity(value, { subjectaltname: "IP Address:" + value }), JSON.stringify(value)).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  }
});

test("SAN escaping cannot create an identifier after a quoted separator", () => {
  expect(identity.checkServerIdentity("secure.example", { subject: { CN: "secure.example" }, subjectaltname: 'DNS:"bad.example, DNS:secure.example"' })).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  expect(identity.checkServerIdentity("secure.example", { subjectaltname: 'DNS:"bad\\u0000.example", DNS:secure.example' })).toBeUndefined();
  expect(identity.checkServerIdentity("secure.example", { subjectaltname: "DNS:secure.example\0.bad" })).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  for (const alt of ['DNS:"bad\\x"', 'DNS:"bad\n"', 'DNS:"bad\\u123"', 'DNS:"bad\\', 'DNS:"bad']) {
    expect(thrownCode(() => identity.checkServerIdentity("secure.example", { subjectaltname: alt })), JSON.stringify(alt)).toBe("ERR_TLS_CERT_ALTNAME_FORMAT");
  }
});

test("one trailing dot is permitted but malformed and empty host labels do not match", () => {
  const cert = { subjectaltname: "DNS:secure.example" };
  expect(identity.checkServerIdentity("secure.example.", cert)).toBeUndefined();
  expect(identity.checkServerIdentity("secure.example..", cert)).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  expect(identity.checkServerIdentity(".example", { subjectaltname: "DNS:*.example" })).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  expect(identity.checkServerIdentity("。example.com", { subjectaltname: "DNS:*.example.com" })).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  expect(identity.checkServerIdentity("secure.example", { subject: { CN: "secure.example" }, subjectaltname: "" })).toBeUndefined();
});

test("invalid callback return values fail without exposing the returned value", () => {
  const request = { chainVerified: true, target: { kind: "dns", hostname: "secure.example", servername: "" }, cert: {}, rejectUnauthorized: false, checkServerIdentity: () => "private return value" };
  const result: unknown = Reflect.apply(identity.verifyIdentity, identity, [request]);
  expect(result).toMatchObject({ kind: "rejected", authorizationError: { code: "ERR_INVALID_ARG_TYPE", message: "checkServerIdentity must return an Error or undefined" } });
});


test("only a literal false opts out of verification at the source boundary", () => {
  for (const rejectUnauthorized of [undefined, null, 0, ""]) {
    const target: unknown = Reflect.apply(identity.selectTarget, identity, [{ rejectUnauthorized }]);
    expect(target).toMatchObject({ code: "ERR_TLS_HOSTNAME_REQUIRED" });
    const decision: unknown = Reflect.apply(identity.verifyIdentity, identity, [{ chainVerified: false, authorizationError: new Error("chain"), rejectUnauthorized }]);
    expect(decision).toMatchObject({ kind: "rejected" });
  }
});
