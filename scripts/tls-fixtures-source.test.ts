import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { handleTlsFixtureRequest, isTlsFixturePath } from "../tests/servers/tls-fixtures.ts";

const root = resolve(import.meta.dir, "..");
const serverSource = readFileSync(join(root, "tests/servers/tls-fixtures.ts"), "utf8");
const guestSource = readFileSync(join(root, "tests/fixtures/tls-client/index.ts"), "utf8");
const expected = readFileSync(join(root, "tests/fixtures/tls-client/expected.txt"), "utf8").trimEnd().split("\n");

afterEach(async () => {
  await handleTlsFixtureRequest(new Request("http://127.0.0.1/tls-fixtures/close", { method: "POST" }));
});

describe("native TLS fixture source contract", () => {
  test("recognizes only its typed control route", () => {
    expect(isTlsFixturePath("/tls-fixtures")).toBe(true);
    expect(isTlsFixturePath("/tls-fixtures/state")).toBe(true);
    expect(isTlsFixturePath("/tls-fixtures/close")).toBe(true);
    expect(isTlsFixturePath("/tls-fixtures-other")).toBe(false);
    expect(isTlsFixturePath("/text")).toBe(false);
  });

  test("keeps fixture creation lazy on import and unrelated routes", async () => {
    expect(await handleTlsFixtureRequest(new Request("http://127.0.0.1/text"))).toBeUndefined();
    const response = await handleTlsFixtureRequest(new Request("http://127.0.0.1/tls-fixtures", { method: "POST" }));
    expect(response?.status).toBe(404);
    const close = await handleTlsFixtureRequest(new Request("http://127.0.0.1/tls-fixtures/close", { method: "POST" }));
    expect(await close?.json()).toEqual({ closed: true });
  });

  test("completes observer arming before publishing the manifest", async () => {
    const response = await handleTlsFixtureRequest(new Request("http://127.0.0.1/tls-fixtures"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ version: 1 });
  });

  test("owns generated credentials and live-server teardown in the route module", () => {
    expect(serverSource).toContain('process.env.TMPDIR ?? tmpdir()');
    expect(serverSource).toContain('mkdtemp(join(base, "bun-wasm-tls-fixtures-"))');
    expect(serverSource).toContain('installSignalCleanup(close)');
    expect(serverSource).toContain('process.exitCode = signalExitCode(signal)');
    expect(serverSource).toContain('process.exit()');
    expect(serverSource).toContain('await rm(scratch, { recursive: true, force: true })');
    expect(serverSource).toContain('observerArmed');
    expect(serverSource).toContain('startTlsConnections');
    expect(serverSource).not.toContain("/tmp/");
    expect(serverSource).not.toMatch(/console\.(log|error)\(/);
  });

  test("uses the real guest TLS and net entry points", () => {
    expect(guestSource).toContain('from "node:net"');
    expect(guestSource).toContain('from "node:tls"');
    expect(guestSource).toContain("process.env.TEST_SERVER");
    expect(guestSource).toContain("new TLSSocket(raw");
    expect(guestSource).toContain("response[0] !== 0x53");
    expect(guestSource).toContain("raw.unshift(remainder)");
    expect(guestSource).toContain('const expected = Buffer.from("starttls-payload")');
    expect(guestSource).toContain("echoed = Buffer.concat([echoed, bytes])");
    expect(guestSource).toContain("Reflect.apply(tlsConnect");
    expect(guestSource).toContain("observerPlaintextBytes");
    expect(guestSource).toContain("starttlsState.connections === 1");
    expect(guestSource).toContain("starttlsState.startTlsConnections === 1");
  });

  test("keeps output deterministic and free of endpoints or key material", () => {
    expect(expected).toHaveLength(18);
    expect(expected.every(line => !/\b\d{4,5}\b/.test(line))).toBe(true);
    expect(expected.every(line => !line.includes("BEGIN "))).toBe(true);
    expect(expected).toEqual([
      "tls12: TLSv1.2",
      "tls13: TLSv1.3",
      "default reject: true",
      "explicit ca: true",
      "empty ca replacement: true",
      "hostname reject: true",
      "alpn: fixture/2",
      "peer metadata: true",
      "client identity: true",
      "identity receiver: true",
      "identity error: true",
      "early write barrier: true",
      "starttls one connection: true",
      "abort destroy: true",
      "reentrant destroy: true",
      "half close: true",
      "generic duplex unsupported: true",
      "negative observer: armed and zero plaintext",
    ]);
  });
});
