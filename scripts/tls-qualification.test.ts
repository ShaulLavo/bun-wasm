import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, symlink } from "node:fs/promises";
import { parseTlsArguments } from "./tls-qualification.ts";
import { preflightTls, parseParentIntake, deliveryPath } from "./tls-qualification-inputs.ts";
import { qualifiedRun, TlsCleanup } from "./tls-qualification-lifecycle.ts";
import { qualificationCases, assertCaseContext, assertPgResult } from "./tls-qualification-context.ts";
import { qualificationFixture } from "./tls-qualification-fixture.ts";
import { PgWireAudit } from "../web/tests/tls-relay-services.ts";

async function invalidFixture(change: (fixture: Awaited<ReturnType<typeof qualificationFixture>>) => Promise<void>, expected: RegExp, reseal = true) {
  const fixture = await qualificationFixture();
  let setups = 0;
  try {
    let inputs = await fixture.seal();
    await change(fixture);
    if (reseal) inputs = await fixture.seal();
    await expect(qualifiedRun(() => preflightTls(inputs), async () => { setups++; throw new Error("Setup must never run"); }, async () => {})).rejects.toThrow(expected);
    expect(setups).toBe(0);
  } finally { await fixture.close(); }
}
describe("TLS evidence is a gate before setup", () => {
  test("rejects CURRENT and a successful source-only status", () => {
    expect(() => parseParentIntake({ kind: "consumer-qualification-status-NOT-admission", ok: true }, { head: "a".repeat(40), tree: "b".repeat(40) }, "/fixture")).toThrow("Independent parent");
  });
  test("rejects parent source head mismatch", () => invalidFixture(async fixture => { fixture.parent.source = { head: "c".repeat(40), tree: "b".repeat(40) }; }, /source head\/tree/));
  test("rejects parent source tree mismatch", () => invalidFixture(async fixture => { fixture.parent.source = { head: "a".repeat(40), tree: "c".repeat(40) }; }, /source head\/tree/));
  test("rejects a runtime107 or missing relay tuple", () => invalidFixture(async fixture => { fixture.parent.tuple = { runtime: "0.0.107", hostInterface: 1, engines: ["quickjs", "jsc", "browser"] }; }, /runtime\/relay109/));
  test("rejects changed parent bytes before reading payloads", () => invalidFixture(async fixture => { await fixture.put(join(fixture.root, "parent.json"), { kind: "changed" }); }, /pinned evidence hash/, false));
  test("rejects changed artifact bytes before setup", () => invalidFixture(async fixture => { await fixture.put(join(fixture.delivery, "source.tar.gz"), "tampered"); }, /byte\/custody mismatch/, false));
  test("rejects missing parent custody", () => invalidFixture(async fixture => { fixture.parent.gates = {}; }, /parent custody/));
  test("rejects changed producer source", () => invalidFixture(async fixture => {
    const path = join(fixture.delivery, "inputs/ADMISSION.json");
    const value = JSON.parse(await readFile(path, "utf8")); value.source.head = "e".repeat(40); await fixture.put(path, value);
  }, /source head\/tree/));
  test("rejects before/after/preseal custody mismatch", () => invalidFixture(async fixture => { await fixture.put(join(fixture.delivery, "inputs/vendor-custody-after.json"), "changed custody"); }, /custody mismatch/));
  test("rejects mismatched canonical original bytes", () => invalidFixture(async fixture => {
    await fixture.put(join(fixture.delivery, "inputs/CANONICAL-REUSE.json"), { staged: [{ path: "source.tar.gz", originalPath: join(fixture.delivery, "source.tar.gz"), bytes: 1, sha256: "a".repeat(64) }] });
  }, /byte\/custody mismatch/));
  test("rejects symlinks and unsafe paths", async () => {
    expect(() => deliveryPath("/fixture", "../source")).toThrow("Unsafe");
    expect(() => deliveryPath("/fixture", "/source")).toThrow("Unsafe");
    await invalidFixture(async fixture => { await symlink("source.tar.gz", join(fixture.delivery, "extra")); }, /symlink/, false);
  });
  test("the externally pinned source release cannot be replaced by a self-asserted TLS flag", async () => {
    const fixture = await qualificationFixture();
    let setups = 0;
    try {
      const inputs = await fixture.seal();
      await expect(qualifiedRun(() => preflightTls({ ...inputs, sourceReleaseSha256: "0".repeat(64) }), async () => { setups++; }, async () => {})).rejects.toThrow("source release identity mismatch");
      expect(setups).toBe(0);
    } finally { await fixture.close(); }
  });
  test("missing evidence never invokes a factory", async () => {
    let setup = false;
    await expect(qualifiedRun(async () => { throw new Error("No reviewed TLS delivery"); }, async () => { setup = true; }, async () => {})).rejects.toThrow("No reviewed TLS");
    expect(setup).toBe(false);
  });
});
describe("future browser query context", () => {
  const result = { kind: "tls-pg-result", mode: "verified", ssl: true, sameBackend: true, version: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256", bits: 128 };
  test("requires pg_stat_ssl on the same backend", () => {
    expect(assertPgResult(result, "verified").ssl).toBe(true);
    expect(() => assertPgResult({ ...result, ssl: false }, "verified")).toThrow();
    expect(() => assertPgResult({ ...result, sameBackend: false }, "verified")).toThrow();
    expect(() => assertPgResult({ select: 1 }, "verified")).toThrow();
  });
  test("preserves engine and forced WebSocket carrier", () => {
    const context = { engine: "browser", carrier: "websocket", connections: 1, runtimeDisposed: true, relayClosed: true, result };
    expect(assertCaseContext(context, "verified", "browser").carrier).toBe("websocket");
    for (const override of [{ carrier: "webtransport" }, { engine: "jsc" }, { connections: 2 }, { runtimeDisposed: false }, { relayClosed: false }]) expect(() => assertCaseContext({ ...context, ...override }, "verified", "browser")).toThrow();
    expect(qualificationCases).toEqual(["verified", "no-extra-ca", "hostname", "rejection", "plaintext"]);
  });
  test("negative controls are separate and require rejection", () => {
    for (const mode of qualificationCases.filter(mode => mode !== "verified")) {
      expect(assertPgResult({ kind: "tls-pg-result", mode, rejected: true }, mode).rejected).toBe(true);
      expect(() => assertPgResult({ ...result, mode }, mode)).toThrow();
    }
  });
  test("actual guest source keeps literal ssl true and never imports page-native pg", async () => {
    const guest = await readFile(new URL("../web/tests/fixtures/tls/pg-client.ts", import.meta.url), "utf8");
    expect(guest).toContain('ssl: true');
    expect(guest).not.toContain('rejectUnauthorized: false');
    expect(guest).toContain("FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
    const page = await readFile(new URL("../web/tests/tls-relay-page.ts", import.meta.url), "utf8");
    expect(page.indexOf("await seed(runtime")).toBeLessThan(page.indexOf("active = startRun("));
    expect(page).toContain('NODE_EXTRA_CA_CERTS: "/home/user/tls/ca.pem"');
    expect(page).not.toContain('require("pg")');
    expect(page).not.toContain('import("pg")');
  });
});
describe("wire witnesses and cleanup", () => {
  const request = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
  test("handles fragmented SSLRequest and TLS headers without retaining payload", () => {
    const audit = new PgWireAudit("verified");
    for (const byte of Buffer.concat([request, Buffer.from([22, 3, 3, 0, 3, 1, 2, 3])])) audit.accept(Uint8Array.of(byte));
    expect(audit.result().sslRequests).toBe(1);
    expect(audit.result().plaintextStartupObserved).toBe(false);
  });
  test("detects plaintext startup and any bytes after SSL rejection", () => {
    const audit = new PgWireAudit("no-extra-ca"); audit.accept(Buffer.concat([request, Buffer.from([0, 0, 0, 9, 0, 3, 0, 0, 0])]));
    expect(() => audit.result()).toThrow("Plaintext");
    const rejection = new PgWireAudit("rejection"); rejection.accept(request.subarray(0, 7)); expect(rejection.sslRequests).toBe(0); rejection.accept(request.subarray(7)); expect(rejection.result().bytes).toBe(8);
    rejection.accept(Uint8Array.of(0)); expect(() => rejection.result()).toThrow();
  });
  test("setup failure still tears down all acquired resources once", async () => {
    const released: number[] = [];
    await expect(qualifiedRun(async () => "source-parser-only", async (_, owner) => {
      owner.add(() => { released.push(1); }); owner.add(() => { released.push(2); }); throw new Error("setup failed");
    }, async () => {})).rejects.toThrow("setup failed");
    expect(released).toEqual([2, 1]);
  });
  test("exercise failure and cleanup failure do not skip remaining teardown", async () => {
    const owner = new TlsCleanup(); const released: number[] = [];
    owner.add(() => { released.push(1); }); owner.add(() => { released.push(2); throw new Error("close failed"); });
    const closing = owner.close(); expect(owner.close()).toBe(closing); await expect(closing).rejects.toThrow("cleanup unconfirmed"); expect(released).toEqual([2, 1]);
    let stopped = false;
    await expect(qualifiedRun(async () => 1, async (_, cleanup) => { cleanup.add(() => { stopped = true; }); }, async () => { throw new Error("query failed"); })).rejects.toThrow("query failed");
    expect(stopped).toBe(true);
  });
  test("CLI fails closed before implicit paths or broad stages", () => {
    expect(() => parseTlsArguments([])).toThrow("--stage");
    expect(() => parseTlsArguments(["--stage", "full", "--browser", "chromium"])).toThrow("only pg-early");
    expect(() => parseTlsArguments(["--stage", "pg-early", "--browser", "firefox"])).toThrow("only pg-early");
    expect(() => parseTlsArguments(["--stage", "pg-early", "--stage", "pg-early"])).toThrow("repeated");
  });
});
