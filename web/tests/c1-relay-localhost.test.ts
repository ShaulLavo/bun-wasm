import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { c1InputPaths, c1Ports, C1Cleanup, c1SetupReady, verifyOwnerPreview1 } from "./c1-relay-inputs";
import { assertC1Result, safeC1Result } from "./c1-relay-localhost";
import { assertCarrier, databaseEnvironment, localhostOrigin, publicTopology, requireLocalTopology } from "./fixtures/c1-relay/protocol";
import { pgQuery, noRelay } from "./fixtures/c1-relay/guests";

const inputs = { C1_GUEST_DIRECTORY: "/missing/admitted-matrix", C1_GUEST_DESCRIPTOR: "/missing/descriptor.json",
  C1_PUBLICATION_REPORT: "/missing/publication.json", C1_PG_NODE_MODULES: "/missing/pg/node_modules",
  C1_PREVIEW1_FIXTURE: "/missing/owner-line.wasm", C1_PREVIEW1_SHA256: "1".repeat(64), C1_PREVIEW1_BYTES: "128",
  C1_PREVIEW1_HOST: "line.waffle.internal", C1_PREVIEW1_PORT: "4321", C1_PREVIEW1_STDOUT: "owner-qualified-line\n" };
for (const key of Object.keys(inputs)) test(`C1 rejects missing ${key} before setup`, () => {
  const env: Record<string, string> = { ...inputs };
  delete env[key];
  expect(() => c1InputPaths(env)).toThrow();
});
test("C1 rejects relative artifacts and duplicate listener ports", () => {
  expect(() => c1InputPaths({ ...inputs, C1_GUEST_DIRECTORY: "dist" })).toThrow("absolute admitted input path");
  expect(() => c1Ports({ C1_RELAY_PORT: "43829" })).toThrow("distinct");
  expect(() => c1Ports({ C1_WT_PORT: "443" })).toThrow("unprivileged");
});
for (const endpoint of ["https://bun.sprockt.dev/", "http://localhost:43829/", "http://0.0.0.0:43829/", "http://127.0.0.1:43829/proxy", "http://127.0.0.1:43829/?trust-origin=1"]) test(`C1 refuses non-exact topology ${endpoint}`, () => {
  expect(() => localhostOrigin(endpoint)).toThrow("exact");
});
test("C1 uses exact loopback origins without wildcard or remote publishing", () => {
  expect(localhostOrigin("http://127.0.0.1:43829/")).toBe("http://127.0.0.1:43829");
});
test("C1 reports only completed opens, preserves automatic fallback, and forces WS separately", () => {
  expect(() => assertCarrier("automatic", ["webtransport", "websocket"], 2)).not.toThrow();
  expect(() => assertCarrier("automatic", ["websocket", "websocket"], 2)).not.toThrow();
  expect(() => assertCarrier("automatic", [], 2)).toThrow("Missing completed");
  expect(() => assertCarrier("websocket", ["webtransport"], 1)).toThrow("Forced");
  expect(() => assertCarrier("no-relay", ["websocket"], 0)).toThrow("activated");
});
test("C1 cleanup awaits every registered owner in reverse order, even after failure, once", async () => {
  const owner = new C1Cleanup();
  const events: string[] = [];
  const held = Promise.withResolvers<void>();
  owner.add(() => { events.push("scratch"); });
  owner.add(async () => { events.push("relay-wait"); await held.promise; events.push("relay-closed"); });
  owner.add(() => { events.push("page"); throw new Error("page cleanup unconfirmed"); });
  const closing = owner.close();
  expect(owner.close()).toBe(closing);
  await Promise.resolve();
  expect(events).toEqual(["page", "relay-wait"]);
  held.resolve();
  await expect(closing).rejects.toThrow("C1 cleanup failed");
  expect(events).toEqual(["page", "relay-wait", "relay-closed", "scratch"]);
});
test("C1 rejects unpassed or partial page results, never emits a publication receipt", () => {
  expect(() => assertC1Result({ ok: false })).toThrow("did not pass");
  expect(() => assertC1Result({ ok: true, rows: [], cleanup: {} })).toThrow("omitted");
  expect(() => assertC1Result({ ok: true, rows: ["automatic", "websocket", "no-relay"].map(mode => ({ mode })), cleanup: { workers: 1 } })).toThrow("not confirmed");
});
test("C1 retains the real pg ssl:false query and unchanged no-relay behavior", () => {
  expect(pgQuery).toContain('from "pg"');
  expect(pgQuery).toContain('ssl: false');
  expect(pgQuery).toContain('client.query("SELECT 1")');
  expect(pgQuery).toContain("password: process.env.PGPASSWORD");
  expect(pgQuery).toContain("if (!process.env.PGPASSWORD)");
  expect(pgQuery).not.toMatch(/token|endpoint/);
  expect(noRelay).toContain('error.code === "ENOTSUP"');
  expect(noRelay).toContain('fetch("http://localhost:31979/")');
});
test("C1 entry gates before optional native/service or source bundle setup", async () => {
  const source = await readFile(new URL("./c1-relay-localhost.ts", import.meta.url), "utf8");
  const gate = source.indexOf("const admitted = await admitC1Guest");
  expect(gate).toBeGreaterThan(0);
  expect(source.indexOf("await buildBrowserEntries")).toBeGreaterThan(gate);
  expect(source.indexOf("await startC1Services")).toBeGreaterThan(gate);
  expect(source).not.toContain("launch(");
});

test("C1 requires and forwards the disposable database password without exposing it in diagnostics", () => {
  for (const value of [undefined, {}, { PGPASSWORD: "" }, { PGPASSWORD: 123 }]) expect(() => databaseEnvironment(value)).toThrow("database password was not forwarded");
  const secret = "unit-only-database-password";
  expect(databaseEnvironment({ PGPASSWORD: secret })).toEqual({ PGPASSWORD: secret });
  try { databaseEnvironment({ password: secret }); } catch (error) { expect(String(error)).not.toContain(secret); }
});

test("C1 wires PGPASSWORD into the real guest environment, never the report or relay configuration", async () => {
  const page = await readFile(new URL("./c1-relay-page.ts", import.meta.url), "utf8");
  const services = await readFile(new URL("./c1-relay-services.ts", import.meta.url), "utf8");
  expect(page).toContain('databaseEnvironment(await response.json())');
  expect(page).toContain('await guestDatabaseEnvironment()');
  expect(page).toContain('PATH: "/bin:/usr/bin", ...database');
  expect(services).toContain('"--env", "POSTGRES_PASSWORD"');
  expect(services).toContain('POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256');
  expect(services).not.toContain('POSTGRES_HOST_AUTH_METHOD=trust');
  expect(services).not.toContain('console.log');
});

test("C1 public mode preserves the owner's exact names and cannot silently run a localhost substitute", () => {
  expect(publicTopology).toEqual({ pageOrigin: "https://waffle-network.sprockt.dev", relayEndpoint: "https://waffle-relay-public.sprockt.dev/" });
  expect(() => requireLocalTopology("public")).toThrow("network owner's qualified");
  expect(() => requireLocalTopology("localhost")).not.toThrow();
  expect(() => requireLocalTopology("mesh")).toThrow("must be localhost or public");
});
test("C1 consumes the owner-qualified fixture through the Bun manual launcher, without compiling a generic Waffle proof", async () => {
  const source = await readFile(new URL("./c1-relay-localhost.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("./c1-relay-page.ts", import.meta.url), "utf8");
  expect(source).not.toContain("wasm-tools");
  expect(page).toContain('adapter: "preview1"');
  expect(page).toContain('socket: { connect: selected.preview1.target }');
  expect(page).toContain('output === selected.preview1.expectedStdout');
});

test("C1 rejects mismatched owner fixture length or digest without compiling a guest", () => {
  const bytes = new Uint8Array(8);
  expect(() => verifyOwnerPreview1(bytes, { bytes: 9, sha256: "1".repeat(64) })).toThrow("differ from the qualified identity");
  expect(() => verifyOwnerPreview1(bytes, { bytes: 8, sha256: "1".repeat(64) })).toThrow("differ from the qualified identity");
});

test("C1 emitted results discard unknown configuration fields and reject missing carrier proofs", () => {
  const rows = [
    { mode: "automatic", carriers: ["websocket", "websocket"], query: "SELECT 1", bunPreview1Adapter: true, PGPASSWORD: "unit-only-private-value" },
    { mode: "websocket", carriers: ["websocket", "websocket"], query: "SELECT 1", bunPreview1Adapter: true },
    { mode: "no-relay", carriers: [], query: "loopback and ENOTSUP", bunPreview1Adapter: false },
  ];
  const cleanup = { workers: 0, runtimeDisposed: true, relayClosed: true };
  const value = { ok: true, rows, cleanup, token: "unit-only-relay-value" };
  expect(JSON.stringify(safeC1Result(value))).not.toContain("unit-only");
  rows[0]!.carriers.length = 0;
  expect(() => safeC1Result(value)).toThrow("Missing completed");
});

test("C1 setup cancellation reaches its owner's teardown without awaiting an unready native endpoint", async () => {
  const ready = Promise.withResolvers<void>();
  const signal = new AbortController();
  const setup = c1SetupReady(ready.promise, signal.signal);
  signal.abort();
  await expect(setup).rejects.toThrow("C1 setup cancelled");
  ready.resolve();
});
