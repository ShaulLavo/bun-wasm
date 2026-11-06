import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
assert.equal(require("pg/package.json").version, "8.16.3");
const mode = process.env.TLS_PG_CASE;
assert.ok(mode === "verified" || mode === "no-extra-ca" || mode === "hostname" || mode === "rejection" || mode === "plaintext");
assert.ok(process.env.PGPASSWORD, "Run-generated private password required");
if (mode === "verified" || mode === "hostname" || mode === "rejection") assert.equal(process.env.NODE_EXTRA_CA_CERTS, "/home/user/tls/ca.pem");
if (mode === "no-extra-ca") assert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined);
const options = {
  host: process.env.PGHOST, port: Number(process.env.PGPORT), user: "postgres", database: "postgres",
  password: process.env.PGPASSWORD, connectionTimeoutMillis: 15_000,
};
const client = new Client(mode === "plaintext" ? { ...options, ssl: false } : { ...options, ssl: true });
// Keep this client standalone: the browser seeds this file as query.ts.
function diagnosticText(value: string, limit: number): string {
  const password = process.env.PGPASSWORD ?? "";
  const forms = password ? [password, JSON.stringify(password).slice(1, -1), encodeURIComponent(password)] : [];
  const safe = forms.reduce((text, form) => text.split(form).join("[redacted run secret]"), value);
  let bounded = "", encodedLength = 0;
  for (const character of safe) {
    encodedLength += JSON.stringify(character).length - 2;
    if (encodedLength > limit) return bounded + " [truncated]";
    bounded += character;
  }
  return bounded;
}
function diagnosticError(error: unknown, depth = 0): object {
  if (!error || typeof error !== "object") return { name: "NonErrorThrow", message: diagnosticText(String(error), 384) };
  const field = (key: string, limit: number) => {
    const value: unknown = Reflect.get(error, key);
    return typeof value === "string" ? diagnosticText(value, limit) : typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const cause: unknown = Reflect.get(error, "cause");
  return { name: field("name", 64), code: field("code", 96), message: field("message", 384),
    cause: cause === undefined ? null : depth < 2 ? diagnosticError(cause, depth + 1) : { truncated: true } };
}
let connected = false;
let failure: { error: unknown } | undefined;
try {
  await client.connect();
  connected = true;
  assert.equal(mode, "verified", "A negative control connected");
  const result = await client.query("SELECT ssl, version, cipher, bits, pid = pg_backend_pid() AS same_backend FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.ssl, true);
  assert.equal(row.same_backend, true);
  assert.ok(row.version === "TLSv1.2" || row.version === "TLSv1.3");
  assert.equal(typeof row.cipher, "string");
  assert.ok(row.cipher.length > 0 && row.bits >= 128);
  process.stdout.write(JSON.stringify({ kind: "tls-pg-result", mode, ssl: row.ssl, sameBackend: row.same_backend, version: row.version, cipher: row.cipher, bits: row.bits }) + "\n");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  const expected = mode === "hostname" ? code === "ERR_TLS_CERT_ALTNAME_INVALID"
    : mode === "no-extra-ca" ? ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"].includes(String(code))
    : mode === "rejection" ? /does not support SSL/i.test(message)
    : code === "28000";
  if (connected || mode === "verified" || !expected) {
    failure = { error };
    process.stderr.write(JSON.stringify({ kind: "tls-pg-failure", mode, connected, error: diagnosticError(error) }) + "\n");
  } else process.stdout.write(JSON.stringify({ kind: "tls-pg-result", mode, rejected: true }) + "\n");
} finally {
  try { await client.end(); } catch (error) {
    failure = { error: failure ? new AggregateError([failure.error, error], "TLS pg case and cleanup failed", { cause: failure.error }) : error };
  }
}
if (failure) throw failure.error;
