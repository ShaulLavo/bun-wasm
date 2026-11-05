import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { completePublicationArtifactPaths, tlsPagePaths } from "../producer-closure.ts";
import { TLS_RESERVED_PORTS, fixtureDrafts, parseConfig, parseHandoff, type ConsumerHandoff } from "./contract.ts";
import { FIXTURE_SOURCE, FIXTURE_TLS_OPTIONS, writeContractFixture } from "./contract-fixture.ts";
import { requireHandoffArtifacts } from "./delivery.ts";
import { fileIdentity, sha256, treeIdentity } from "./identity.ts";
import { bindLoaded, parseLoaded, type LoadedObservation } from "./loaded.ts";
import { TLS_PAGE_ENTRY, TLS_PAGE_WORKERS, TLS_PG_CLIENT, UNRESOLVED_RELAY, prepareTlsPage, verifyTlsPage, type PageBuilder } from "./tls-page.ts";
import { completedConsumerResult, fiveOwnerDriver, tlsDriver } from "./operations.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bun-wasm-c1-tls-")));
afterAll(() => {
  execFileSync("/usr/bin/chmod", ["-R", "u+w", scratch]);
  rmSync(scratch, { recursive: true, force: true });
});
let count = 0;
function fresh(): string { return join(scratch, String(++count)); }
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("five-owner admitted invocations use only the pinned handoff and surface selection", () => {
  const fixture = writeContractFixture(fresh());
  const handoff = parseHandoff(json(fixture.handoff));
  const sourceRoot = fresh();
  write(join(sourceRoot, "scripts/io-resource-context.ts"), "// Synthetic driver presence only.\n");
  const handoffFile = fileIdentity(fixture.handoff);
  const drivers = fiveOwnerDriver(handoff, { sourceRoot, env: { BUN_EXE: process.execPath }, handoffFile });
  if (typeof drivers === "string") throw new Error(drivers);
  expect(drivers).toHaveLength(3);
  for (const [index, name] of ["quickjs", "jsc", "chromium"].entries()) {
    const selection = name === "chromium" ? ["--surface", "chromium"] : ["--surface", "native", "--engine", name];
    expect(drivers[index]?.argv).toEqual([process.execPath, "scripts/io-resource-context.ts"].concat(selection,
      ["--handoff", handoffFile.path, "--handoff-sha256", handoffFile.sha256, "--out", join(handoff.outputs["five-owner"], name)]));
  }
});

test.each(["partial", "pending-intake", "source-check"])("exit-zero %s evidence is preserved without declaring qualification", status => {
  const child = { status, qualification: { status: "unqualified" }, coverage: { exactNativeTurn: false }, unqualified: ["exact native turn facts unavailable"] };
  const outcome = completedConsumerResult("/synthetic/output", child);
  expect(outcome.status).toBe("completed");
  expect(outcome.result).toEqual(child);
});

test("TLS result readback uses exactly the output directory passed to the driver", () => {
  const fixture = writeContractFixture(fresh());
  const parsed = parseHandoff(json(fixture.handoff));
  const pgRoot = fresh();
  for (const name of ["pg.tgz", "package.json", "bun.lock", "modules/pg/index.js"]) write(join(pgRoot, name), `synthetic ${name}\n`);
  const handoff: ConsumerHandoff = { ...parsed, dependencies: { ...parsed.dependencies, tls: { status: "resolved", value: {
    pgTarball: fileIdentity(join(pgRoot, "pg.tgz")), pgPackageJson: fileIdentity(join(pgRoot, "package.json")),
    pgLock: fileIdentity(join(pgRoot, "bun.lock")), pgModules: treeIdentity(join(pgRoot, "modules")),
  } } } };
  const invocations = tlsDriver(handoff, { sourceRoot: scratch, env: { BUN_EXE: process.execPath }, handoffFile: fileIdentity(fixture.handoff) });
  if (typeof invocations === "string") throw new Error(invocations);
  expect(invocations).toHaveLength(1);
  const driver = invocations[0];
  if (!driver) throw new Error("missing TLS driver");
  const option = driver.argv.indexOf("--output");
  expect(option).toBeGreaterThanOrEqual(0);
  const output = driver.argv[option + 1];
  if (option < 0 || output === undefined) throw new Error("missing TLS output argument");
  expect(driver.out).toBe(output);
  expect(driver.out).toBe(join(handoff.outputs.tls, "pg-early"));
});

test("the one config carries typed TLS fixture options and the handoff propagates them unchanged", () => {
  const fixture = writeContractFixture(fresh());
  const config = parseConfig(json(fixture.config));
  expect(config.fixtures.tls).toEqual({ status: "resolved", value: FIXTURE_TLS_OPTIONS });
  expect(parseHandoff(json(fixture.handoff)).fixtures).toEqual(config.fixtures);
  expect(fixtureDrafts(config.fixtures)).toEqual([]);
  // The TLS contract's private PostgreSQL and native trust observer ports.
  expect(TLS_RESERVED_PORTS).toEqual([45433, 45434]);
  expect(fixtureDrafts({ tls: { status: "unresolved", missing: "database host not admitted" } })).toEqual(["fixtures.tls: database host not admitted"]);
});

test.each([
  ["an unknown secret field", { password: "x" }, "unknown field password"],
  ["a public database address", { databaseAddress: "8.8.8.8" }, "private fleet address"],
  ["a loopback relay address", { relayAddress: "127.0.0.1" }, "private fleet address"],
  ["a malformed address", { databaseAddress: "10.0.0.256" }, "exact IPv4"],
  ["one address for both", { relayAddress: FIXTURE_TLS_OPTIONS.databaseAddress }, "must differ"],
  ["the page host as database", { databaseMachine: "localhost" }, "not the page host"],
  ["the PC as database", { databaseMachine: "pc" }, "not the page host"],
  ["conflicting ports", { relayPort: FIXTURE_TLS_OPTIONS.pagePort }, "ports must differ"],
  ["a privileged port", { pagePort: 443 }, "unprivileged port"],
  ["the PostgreSQL port", { relayPort: 45433 }, "reserved"],
  ["the trust observer port", { pagePort: 45434 }, "reserved"],
  ["a fractional port", { pagePort: 43839.5 }, "unprivileged port"],
])("TLS fixture options with %s refuse", (_name, change, message) => {
  const fixture = writeContractFixture(fresh());
  const config = json(fixture.config) as { fixtures: { tls: { value: Record<string, unknown> } } };
  config.fixtures.tls.value = { ...config.fixtures.tls.value, ...change };
  expect(() => parseConfig(config)).toThrow(message);
});

test("missing or altered TLS options and an undefined fixture block refuse", () => {
  const fixture = writeContractFixture(fresh());
  const config = json(fixture.config) as Record<string, unknown> & { fixtures: { tls: { value: Record<string, unknown> } } };
  const { relayAddress: _relay, ...missing } = config.fixtures.tls.value;
  expect(() => parseConfig({ ...config, fixtures: { tls: { status: "resolved", value: missing } } })).toThrow("missing relayAddress");
  const { fixtures: _fixtures, ...without } = config;
  expect(() => parseConfig(without)).toThrow("missing fixtures");
  const handoff = json(fixture.handoff) as Record<string, unknown>;
  expect(() => parseHandoff({ ...handoff, fixtures: { tls: { status: "resolved", value: { ...FIXTURE_TLS_OPTIONS, databaseAddress: "1.1.1.1" } } } })).toThrow("private fleet address");
});

/** A synthetic source root with the page entry, workers and pg client, and a builder that writes plausible bundles. */
function pageSource(): { root: string; build: PageBuilder } {
  const root = fresh();
  for (const path of [TLS_PAGE_ENTRY].concat(TLS_PAGE_WORKERS)) write(join(root, path), `export const name = ${JSON.stringify(path)};\n`);
  write(join(root, TLS_PG_CLIENT), "console.log('pg client');\n");
  write(join(root, "web/node_modules/waffle/index.ts"), "export const waffle = 1;\n");
  const build: PageBuilder = async (entries, outdir) => {
    for (const entry of entries) write(join(outdir, `${entry.split("/").at(-1)?.replace(/\.ts$/, ".js")}`), `bundle of ${entry}\n`);
    write(join(outdir, "chunks/shared-1.js"), "shared\n");
    return { metafile: { inputs: Object.fromEntries([TLS_PAGE_ENTRY, "web/node_modules/waffle/index.ts"].concat(TLS_PAGE_WORKERS).map(path => [path, {}])) } };
  };
  return { root, build };
}
async function deliveredPage() {
  const { root, build } = pageSource();
  const delivery = fresh();
  await prepareTlsPage(root, FIXTURE_SOURCE, join(delivery, "tls"), build);
  return { root, delivery };
}

test("the TLS page is built before sealing and bound to its inputs and outputs", async () => {
  const { root, delivery } = await deliveredPage();
  const receipt = verifyTlsPage(delivery, root, FIXTURE_SOURCE);
  expect(receipt.inputs.map(input => input.path)).toContain("web/node_modules/waffle/index.ts");
  expect(receipt.outputs.map(output => `tls/${output.path}`)).toEqual(expect.arrayContaining([tlsPagePaths.index, tlsPagePaths.entry, tlsPagePaths.pgClient].concat(tlsPagePaths.workers)));
  for (const path of [tlsPagePaths.index, tlsPagePaths.entry, tlsPagePaths.receipt, tlsPagePaths.pgClient].concat(tlsPagePaths.workers)) expect(completePublicationArtifactPaths()).toContain(path);
});

test("a page that still imports its relay at run time is refused before sealing", async () => {
  const { root, build } = pageSource();
  const unresolved: PageBuilder = async (entries, outdir, options) => {
    const result = await build(entries, outdir, options);
    write(join(outdir, "tls-relay-page.js"), `const entry = "${UNRESOLVED_RELAY}"; await import(entry);\n`);
    return result;
  };
  await expect(prepareTlsPage(root, FIXTURE_SOURCE, join(fresh(), "tls"), unresolved)).rejects.toThrow("relay import must be static");
});

test("a builder input outside the selected source is refused", async () => {
  const { root, build } = pageSource();
  const outside: PageBuilder = async (entries, outdir, options) => ({ metafile: { inputs: { ...(await build(entries, outdir, options)).metafile?.inputs, "../elsewhere.ts": {} } } });
  await expect(prepareTlsPage(root, FIXTURE_SOURCE, join(fresh(), "tls"), outside)).rejects.toThrow("outside the selected source");
});

test.each([
  ["a changed page byte", (delivery: string) => writeFileSync(join(delivery, tlsPagePaths.entry), "changed")],
  ["a missing worker", (delivery: string) => rmSync(join(delivery, "tls/page/fs-worker.js"))],
  ["an extra script", (delivery: string) => write(join(delivery, "tls/page/extra.js"), "extra")],
  ["a pg client from elsewhere", (delivery: string) => writeFileSync(join(delivery, tlsPagePaths.pgClient), "other")],
])("a delivered TLS page with %s refuses", async (_name, change) => {
  const { root, delivery } = await deliveredPage();
  change(delivery);
  expect(() => verifyTlsPage(delivery, root, FIXTURE_SOURCE)).toThrow();
});

test("a TLS page receipt from another source, or a changed bundled input, refuses", async () => {
  const { root, delivery } = await deliveredPage();
  expect(() => verifyTlsPage(delivery, root, { head: "f".repeat(40), tree: "e".repeat(40) })).toThrow("another source");
  writeFileSync(join(root, "web/node_modules/waffle/index.ts"), "changed dependency");
  expect(() => verifyTlsPage(delivery, root, FIXTURE_SOURCE)).toThrow("input changed");
});

function fixtureHandoff(): { handoff: ConsumerHandoff; web: LoadedObservation[]; tls: LoadedObservation[] } {
  const fixture = writeContractFixture(fresh());
  return { handoff: parseHandoff(json(fixture.handoff)), web: parseLoaded((json(fixture.loadedWeb) as { loaded: unknown }).loaded), tls: parseLoaded((json(fixture.loadedTls) as { loaded: unknown }).loaded) };
}

test("observed web and TLS responses bind to admitted members, including decoded gzip", () => {
  const { handoff, web, tls } = fixtureHandoff();
  expect(bindLoaded(handoff, "web", web).map(binding => binding.route)).toEqual(["web", "web"]);
  expect(bindLoaded(handoff, "tls", tls).map(binding => binding.route)).toEqual(["tls-page", "tls-page", "tls-fixture", "guest-artifact", "control"]);
});

test("a selected gzip-only Browser response binds without an unrelated Wasm row", () => {
  const { handoff, web } = fixtureHandoff();
  const bytes = readFileSync(join(handoff.webRoot, "bun.wasm.gz"));
  const row: LoadedObservation = { url: "http://127.0.0.1:43839/bun.wasm.gz", method: "GET", status: 200,
    encoding: "identity", bytes: bytes.byteLength, sha256: sha256(bytes) };
  const html = web[0];
  if (!html) throw new Error("missing Browser page observation");
  expect(bindLoaded(handoff, "web", [html, row]).map(binding => binding.member)).toContain(join(handoff.webRoot, "bun.wasm.gz"));
  expect(() => bindLoaded(handoff, "web", [html, { ...row, sha256: sha256("changed") }])).toThrow("differ from the admitted member");
});

test.each([
  ["a byte mismatch", (rows: LoadedObservation[]) => rows.map((row, index) => index === 1 ? { ...row, sha256: sha256("other") } : row), "differ from the admitted member"],
  ["an unadmitted script", (rows: LoadedObservation[]) => rows.concat([{ ...rows[0]!, url: "http://127.0.0.1:43839/evil.js" }]), "not an admitted member"],
  ["an external origin", (rows: LoadedObservation[]) => rows.map(row => ({ ...row, url: row.url.replace("127.0.0.1", "cdn.example.com") })), "loopback"],
  ["two origins", (rows: LoadedObservation[]) => rows.concat([{ ...rows[0]!, url: "http://127.0.0.1:1234/" }]), "one loopback page origin"],
  ["a claimed encoding without that representation", (rows: LoadedObservation[]) => rows.map((row, index) => index === 0 ? { ...row, encoding: "br" as const } : row), "no admitted br representation"],
  // URL parsing resolves dot segments, so an escaping path lands on a non-member of the web root.
  ["a path leaving its root", (rows: LoadedObservation[]) => rows.concat([{ ...rows[0]!, url: "http://127.0.0.1:43839/%2e%2e/%2e%2e/DELIVERY.json" }]), "not an admitted member"],
  ["no WebAssembly", (rows: LoadedObservation[]) => rows.slice(0, 1), "no WebAssembly"],
])("five-owner observations with %s refuse", (_name, change, message) => {
  const { handoff, web } = fixtureHandoff();
  expect(() => bindLoaded(handoff, "web", change(web))).toThrow(message);
});

test("TLS observations bind guests by role and pg seeds only through admitted dependencies", () => {
  const { handoff, tls } = fixtureHandoff();
  const artifact = tls.find(row => row.url.includes("/artifact/"));
  if (!artifact) throw new Error("fixture lacks the guest row");
  expect(() => bindLoaded(handoff, "tls", tls.map(row => row === artifact ? { ...row, url: row.url.replace(/[a-f0-9]{64}$/, handoff.artifacts.config.sha256), sha256: handoff.artifacts.config.sha256 } : row))).toThrow("not the admitted guest");
  expect(() => bindLoaded(handoff, "tls", tls.concat([{ ...artifact, url: "http://127.0.0.1:43839/seed/node_modules/pg/package.json" }]))).toThrow("never admitted");
});

test("loaded rows must be real successful GET observations, not partial claims", () => {
  const { tls } = fixtureHandoff();
  const row = tls[0]!;
  expect(() => parseLoaded(undefined)).toThrow("top-level loaded array");
  expect(() => parseLoaded([{ url: row.url, sha256: row.sha256 }])).toThrow("exactly url, method");
  expect(() => parseLoaded([{ ...row, status: 304 }])).toThrow("successful GET");
  expect(() => parseLoaded([{ ...row, method: "POST" }])).toThrow("successful GET");
  expect(() => parseLoaded([{ ...row, sha256: "x" }])).toThrow("decoded identity");
});

test("delivered TLS members are sealed read-only and checked by the handoff, never repaired", () => {
  const { handoff } = fixtureHandoff();
  requireHandoffArtifacts(handoff);
  for (const role of ["tlsPageIndex", "tlsPageEntry", "tlsPageReceipt", "tlsPgClient"] as const) expect(lstatSync(handoff.artifacts[role].path).mode & 0o777).toBe(0o444);
  expect(lstatSync(join(handoff.tlsPageRoot, "worker.js")).mode & 0o777).toBe(0o444);
  expect(lstatSync(handoff.tlsPageRoot).mode & 0o777).toBe(0o555);
  expect(() => writeFileSync(handoff.artifacts.tlsPageEntry.path, "x")).toThrow();
  const copy = fresh();
  cpSync(handoff.tlsPageRoot, copy, { recursive: true });
  expect(lstatSync(join(copy, "index.html")).mode & 0o222).toBe(0);
});
