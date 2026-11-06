import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { QualificationCase } from "./tls-qualification-context.ts";

const source = readFileSync(new URL("../web/tests/fixtures/tls/pg-client.ts", import.meta.url), "utf8");
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replaceAll("import.meta.url", '"file:///home/user/query.ts"'))
  .replace(/^import .*;\n/gm, "");
const execute = new Function("assert", "createRequire", "process", `return (async () => {${body}\n})();`);
async function fixture(mode: QualificationCase, failure: unknown, connected = false, endFailure?: Error) {
  let ended = false, stdout = "", stderr = "";
  const env = { TLS_PG_CASE: mode, PGPASSWORD: "synthetic-password-for-test-only", NODE_EXTRA_CA_CERTS: mode === "no-extra-ca" ? undefined : "/home/user/tls/ca.pem" };
  const client = { async connect() { if (!connected) throw failure; }, async query() { throw failure; }, async end() { ended = true; if (endFailure) throw endFailure; } };
  const require = (name: string) => name === "pg" ? { Client: class { constructor() { return client; } } } : { version: "8.16.3" };
  const process = { env, stdout: { write(text: string) { stdout += text; } }, stderr: { write(text: string) { stderr += text; } } };
  const caught = await execute(assert, () => require, process).then(() => undefined, (error: unknown) => error);
  return { caught, stdout, stderr, ended };
}

test.each(["verified", "no-extra-ca", "hostname", "rejection", "plaintext"] satisfies QualificationCase[])("%s keeps an unexpected original exception and its cause", async mode => {
  const cause = Object.assign(new Error("transport refused"), { code: "ECONNREFUSED" });
  const failure = Object.assign(new Error("connection failed", { cause }), { code: "EIO" });
  const row = await fixture(mode, failure);
  expect(row.caught).toBe(failure);
  expect(row.stdout).toBe("");
  expect(row.ended).toBe(true);
});

test("a connected negative and a verified query failure retain their actual errors", async () => {
  const failure = Object.assign(new Error("query failed"), { code: "XX000" });
  expect((await fixture("verified", failure, true)).caught).toBe(failure);
  const negative = await fixture("no-extra-ca", failure, true);
  expect(negative.caught).toBeInstanceOf(assert.AssertionError);
  expect(String(negative.caught)).toContain("A negative control connected");
  expect(negative.stdout).toBe("");
  expect(negative.ended).toBe(true);
});

test.each([
  ["no-extra-ca", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unknown issuer"],
  ["no-extra-ca", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unknown issuer"],
  ["no-extra-ca", "SELF_SIGNED_CERT_IN_CHAIN", "self signed"],
  ["hostname", "ERR_TLS_CERT_ALTNAME_INVALID", "wrong hostname"],
  ["rejection", undefined, "The server does not support SSL connections"],
  ["plaintext", "28000", "TLS required"],
] satisfies [QualificationCase, string | undefined, string][])("%s still accepts only the intended rejection %s", async (mode, code, message) => {
  const row = await fixture(mode, Object.assign(new Error(message), { code }));
  expect(row.caught).toBeUndefined();
  expect(JSON.parse(row.stdout)).toEqual({ kind: "tls-pg-result", mode, rejected: true });
  expect(row.stderr).toBe("");
  expect(row.ended).toBe(true);
});

test.each([new Error("generic rejection"), "not an error", { message: "does not support SSL" }])("a generic rejection is never a certificate control pass", async failure => {
  const row = await fixture("no-extra-ca", failure);
  expect(row.caught).toBe(failure);
  expect(row.stdout).toBe("");
});

test("failure diagnostics keep codes and causes, redact password forms and bound hostile text and cycles", async () => {
  const password = "synthetic-password-for-test-only";
  const cause = Object.assign(new Error(`nested ${password}`), { code: "ECONNRESET" });
  const failure = Object.assign(new Error(`${password} ${encodeURIComponent(password)} ` + "x".repeat(10000), { cause }), { code: "EIO" });
  cause.cause = failure;
  const row = await fixture("no-extra-ca", failure);
  expect(row.stderr).not.toContain(password);
  expect(row.stderr.length).toBeLessThan(4096);
  const record = JSON.parse(row.stderr);
  expect(record).toMatchObject({ kind: "tls-pg-failure", mode: "no-extra-ca", connected: false, error: { code: "EIO", cause: { code: "ECONNRESET" } } });
  expect(record.error.message).toContain("[redacted run secret]");
  expect(row.caught).toBe(failure);
});

test("the observer retains a split failure record after a long unhandled-error dump", async () => {
  const { GuestObserver } = await import("../web/tests/tls-relay-browser.ts");
  const { RunSecrets } = await import("../tests/servers/tls.ts");
  const secrets = new RunSecrets();
  const password = "synthetic-observer-password-only";
  secrets.add(password);
  const observer = new GuestObserver(secrets);
  observer.begin("no-extra-ca");
  const diagnostic = JSON.stringify({ kind: "tls-pg-failure", mode: "no-extra-ca", error: { code: "ECONNRESET", message: password } });
  let seq = 0;
  const stderr = (text: string) => observer.accept({ seq: ++seq, worker: 1, path: "worker.js", type: "stderr", bytes: text.length, text });
  stderr(diagnostic.slice(0, 25));
  stderr(diagnostic.slice(25) + "\n" + "x".repeat(12000) + "\n");
  stderr(diagnostic + "\n" + diagnostic + "\n");
  const worker = observer.evidence("no-extra-ca", null, null).workers[0];
  expect(worker?.diagnostics).toHaveLength(2);
  expect(JSON.parse(worker?.diagnostics[0] ?? "")).toMatchObject({ error: { code: "ECONNRESET", message: "[redacted run secret]" } });
  expect(JSON.stringify(worker)).not.toContain(password);
  expect(worker?.stderr.tail.length).toBeLessThanOrEqual(2048);
});

test("the development entry selects one explicit case without a release handoff", async () => {
  const { developmentArguments } = await import("../web/tests/tls-development.ts");
  const args = ["--wasm", "/work/guest.wasm", "--pg-modules", "/work/pg/node_modules", "--output", "/work/result"];
  expect(developmentArguments(args).mode).toBe("no-extra-ca");
  expect(developmentArguments(args.concat(["--case", "verified"])).mode).toBe("verified");
  for (const extra of [["--case", "other"], ["--wasm", "/work/other"], ["--handoff", "/work/old"], ["--case"]]) expect(() => developmentArguments(args.concat(extra))).toThrow();
  expect(() => developmentArguments(["--wasm", "relative"])).toThrow();
});

test("cleanup failure cannot replace the original guest failure", async () => {
  const failure = Object.assign(new Error("connect failed"), { code: "ECONNRESET" });
  const end = new Error("cleanup failed");
  const row = await fixture("no-extra-ca", failure, false, end);
  expect(row.caught).toBeInstanceOf(AggregateError);
  expect(row.caught).toHaveProperty("cause", failure);
  expect(row.caught).toHaveProperty("errors", [failure, end]);
  expect(JSON.parse(row.stderr).error.code).toBe("ECONNRESET");
  expect(row.stdout).toBe("");
});
