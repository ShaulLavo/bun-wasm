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
let connected = false;
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
  if (connected || mode === "verified") throw new Error("TLS pg qualification failed");
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  const expected = mode === "hostname" ? code === "ERR_TLS_CERT_ALTNAME_INVALID"
    : mode === "no-extra-ca" ? ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"].includes(String(code))
    : mode === "rejection" ? /does not support SSL/i.test(message)
    : code === "28000";
  assert.ok(expected, "Control failed for an unexpected reason");
  process.stdout.write(JSON.stringify({ kind: "tls-pg-result", mode, rejected: true }) + "\n");
} finally { await client.end(); }
