import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parseTlsArguments } from "./tls-qualification.ts";
import { guestArtifacts, preflightTls, readVerifiedFile, recheckDependencies, requireInstalledRuntimePackage, tlsReleaseTuple, verifyReviewedHostSource, type TlsEvidence, type TlsIntake } from "./tls-qualification-inputs.ts";
import { qualifiedRun, TlsCleanup, acquireOwned, closeObservedCase } from "./tls-qualification-lifecycle.ts";
import { qualificationCases, assertCaseContext, assertPgResult } from "./tls-qualification-context.ts";
import { qualificationFixture, type FixtureOverrides, type TlsFixture } from "./tls-qualification-fixture.ts";
import { handoffMemberPaths } from "./producer-closure.ts";
import { DELIVERY_RECORDS, type InputManifest } from "./c1/contract.ts";
import { FIXTURE_TUPLE } from "./c1/contract-fixture.ts";
import { fileIdentity } from "./c1/identity.ts";
import { PgWireAudit } from "../web/tests/tls-relay-services.ts";

/**
 * Every fixture here is synthetic parser data built from the controller's
 * exported contract, fixture and seal functions. None of it is product evidence.
 */
const fixtures: TlsFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture(overrides?: FixtureOverrides): TlsFixture {
  const created = qualificationFixture(overrides);
  fixtures.push(created);
  return created;
}
/** Preflight refuses and setup never runs. */
async function refused(evidence: TlsEvidence, expected: RegExp | string): Promise<void> {
  let setups = 0;
  await expect(qualifiedRun(() => preflightTls(evidence), async () => { setups++; }, async () => {})).rejects.toThrow(expected);
  expect(setups).toBe(0);
}
async function admitted(evidence: TlsEvidence): Promise<TlsIntake> {
  let reached: TlsIntake | undefined;
  await qualifiedRun(() => preflightTls(evidence), async intake => { reached = intake; }, async () => {});
  if (!reached) throw new Error("setup was not reached");
  return reached;
}
/** Test-owned tamper of a synthetic sealed member through its temporarily unsealed directory. */
function tamper(fixture: TlsFixture, member: string, change: (path: string) => void): void {
  const directory = dirname(join(fixture.delivery, member));
  chmodSync(directory, 0o700);
  change(join(fixture.delivery, member));
  chmodSync(directory, 0o555);
}
function rewriteJson(path: string, change: (value: Record<string, unknown>) => unknown): void {
  writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")))));
}
function withTls(change: (value: Extract<InputManifest["consumers"]["tls"], { status: "resolved" }>["value"], root: string) => object) {
  return (inputs: InputManifest): InputManifest => {
    const tls = inputs.consumers.tls;
    if (tls.status !== "resolved") throw new Error("fixture TLS dependencies are resolved");
    return { ...inputs, consumers: { ...inputs.consumers, tls: { status: "resolved", value: { ...tls.value, ...change(tls.value, dirname(tls.value.pgTarball.path)) } } } };
  };
}
const paths = handoffMemberPaths();
const other = { head: "c".repeat(40), tree: "d".repeat(40) };

describe("strict controller intake before setup", () => {
  test("an exact synthetic handoff reaches setup with registry identities, modes and dependencies", async () => {
    const f = fixture();
    const launcher = join(f.delivery, paths.launcher);
    const before = lstatSync(launcher);
    const intake = await admitted(f.evidence);
    expect(intake.tuple).toEqual(tlsReleaseTuple);
    expect(intake.source).toEqual(f.source);
    expect(intake.handoff.artifacts.launcher.path).toBe(launcher);
    expect(intake.output).toBe(join(f.root, "qualification/tls"));
    expect(intake.hostSource).toBe(f.host);
    expect(intake.references).toHaveLength(15);
    expect(intake.references.map(row => row.path)).toContain(f.intake);
    expect(intake.references.map(row => row.path)).toContain(join(f.delivery, "inputs/native-custody-preseal.json"));
    expect(intake.dependencies.pg.files.map(row => relative(intake.dependencies.pg.root, row.path))).toEqual(["pg-protocol/index.ts", "pg/lib/index.ts", "pg/package.json"]);
    expect(intake.dependencies.host.map(tree => tree.path)).toEqual([join(f.host, "node_modules"), join(f.host, "web/node_modules")]);
    expect(intake.dependencies.locks).toHaveLength(6);
    const after = lstatSync(launcher);
    expect([after.mode & 0o7777, after.ctimeMs, after.ino]).toEqual([0o555, before.ctimeMs, before.ino]);
  });
  test("guest roles come from the controller registry, not copied paths", async () => {
    const { handoff } = await admitted(fixture().evidence);
    expect(guestArtifacts(handoff, "browser")).toEqual([handoff.artifacts.browserGuest]);
    expect(guestArtifacts(handoff, "quickjs")).toEqual([handoff.artifacts.quickjsGuest, handoff.artifacts.quickjsSide]);
    expect(guestArtifacts(handoff, "jsc")).toEqual([handoff.artifacts.jscGuest, handoff.artifacts.jscSide]);
  });
  test("missing evidence never invokes a factory", async () => {
    let setup = false;
    await expect(qualifiedRun(async () => { throw new Error("No reviewed TLS delivery"); }, async () => { setup = true; }, async () => {})).rejects.toThrow("No reviewed TLS");
    expect(setup).toBe(false);
  });
});

describe("wrong schema", () => {
  test("handoff schema", () => refused(fixture({ handoff: handoff => ({ ...handoff, schema: "bun-wasm.c1-handoff/0" }) }).evidence, /handoff\.schema/));
  test("intake schema", () => refused(fixture({ intake: intake => ({ ...intake, schema: "bun-wasm.c1-intake/0" }) }).evidence, /intake\.schema/));
  test("old parent byte admission shape", () => refused(fixture({ intake: intake => ({ kind: intake.kind, owner: intake.owner, parentByteIntakePassed: true, packetBytesAdmitted: true, source: intake.source, deliveryRoot: intake.deliveryRoot, tuple: { ...intake.tuple, engines: ["quickjs", "jsc", "browser"] } }) }).evidence, /intake: unknown field/));
  test("old ADMISSION.json added after sealing", async () => {
    const f = fixture();
    tamper(f, "inputs/ADMISSION.json", path => writeFileSync(path, "{}"));
    await refused(f.evidence, /missing or extra files/);
  });
  test("engine build registry shape", () => refused(fixture({ members: { [paths.engineBuilds]: "{}" } }).evidence, /Publication asset registry/));
});

describe("wrong root", () => {
  test("intake names another delivery root", () => refused(fixture({ intake: intake => ({ ...intake, deliveryRoot: join(dirname(intake.deliveryRoot), "other") }) }).evidence, /intake names a different delivery/));
  test("sealed config places the delivery elsewhere", () => refused(fixture({ config: config => ({ ...config, roots: { ...config.roots, run: { ...config.roots.run, artifact: join(config.roots.run.artifact, "elsewhere") } } }) }).evidence, /delivery root differs from its sealed config/));
  test("handoff web root", () => refused(fixture({ handoff: handoff => ({ ...handoff, webRoot: join(handoff.webRoot, "other") }) }).evidence, /handoff differs/));
  test("handoff TLS output outside the sealed qualification root", () => refused(fixture({ handoff: handoff => ({ ...handoff, outputs: { ...handoff.outputs, tls: "/work/tmp/foreign-tls" } }) }).evidence, /handoff differs/));
  test("handoff browser scratch", () => refused(fixture({ handoff: handoff => ({ ...handoff, browserTmp: "/work/tmp/other" }) }).evidence, /handoff differs/));
});

describe("wrong source", () => {
  test("reviewed pin", async () => { const f = fixture(); await refused({ ...f.evidence, reviewedSource: other }, /reviewed source head\/tree/); });
  test("intake source", () => refused(fixture({ intake: intake => ({ ...intake, source: other }) }).evidence, /intake source or tuple differs/));
  test("sealed inputs select another source", () => refused(fixture({ inputs: inputs => ({ ...inputs, source: other }) }).evidence, /sealed inputs select another source or tuple/));
  test("delivery of another source than the reviewed host", async () => {
    const f = fixture({ deliverySource: other });
    await refused({ ...f.evidence, reviewedSource: other }, /sealed inputs select another source/);
  });
  test("dirty host checkout", async () => {
    const f = fixture();
    writeFileSync(join(f.host, "untracked.ts"), "export {};\n");
    await refused(f.evidence, /clean reviewed source/);
  });
  test("host checkout at another commit", async () => {
    const f = fixture();
    execFileSync("git", ["-C", f.host, "-c", "user.email=tls@test.invalid", "-c", "user.name=TLS fixture", "commit", "-q", "--allow-empty", "-m", "moved"]);
    await refused(f.evidence, /differs from reviewed TLS source/);
  });
});

describe("wrong tuple", () => {
  test("runtime109 delivery", () => refused(fixture({ tuple: { ...FIXTURE_TUPLE, runtime: "0.0.109" } }).evidence, /runtime110\/relay109/));
  test("runtime107 delivery", () => refused(fixture({ tuple: { ...FIXTURE_TUPLE, runtime: "0.0.107" } }).evidence, /runtime110\/relay109/));
  test("other programs release", () => refused(fixture({ tuple: { ...FIXTURE_TUPLE, programs: "programs-v0.0.14" } }).evidence, /programs15/));
  test("other program manifest schema", () => refused(fixture({ tuple: { ...FIXTURE_TUPLE, programManifestSchema: "waffle-program-release/1" } }).evidence, /schema2/));
  test("intake tuple", () => refused(fixture({ intake: intake => ({ ...intake, tuple: { ...intake.tuple, hostInterface: 2 } }) }).evidence, /intake source or tuple differs/));
  test("installed runtime and relay packages", () => {
    expect(() => requireInstalledRuntimePackage("waffle", { version: "0.0.110" })).not.toThrow();
    expect(() => requireInstalledRuntimePackage("waffle-relay", { version: "0.0.109" })).not.toThrow();
    expect(() => requireInstalledRuntimePackage("waffle", { version: "0.0.109" })).toThrow("runtime110/relay109");
    expect(() => requireInstalledRuntimePackage("waffle-relay", { version: "0.0.110" })).toThrow("runtime110/relay109");
  });
});

describe("wrong manifest and count", () => {
  test("intake bytes differ from the pin", async () => { const f = fixture(); await refused({ ...f.evidence, intakeSha256: "0".repeat(64) }, /pinned SHA-256/); });
  test("intake names other DELIVERY.json bytes", () => refused(fixture({ intake: intake => ({ ...intake, delivery: { ...intake.delivery, sha256: "e".repeat(64) } }) }).evidence, /different DELIVERY\.json/));
  test("sealed config names another input manifest", () => refused(fixture({ config: config => ({ ...config, manifest: { ...config.manifest, sha256: "a".repeat(64) } }) }).evidence, /names another input manifest/));
  test("sealed config record differs from its digest", () => refused(fixture({ members: { [DELIVERY_RECORDS.config]: "{}" } }).evidence, /config record differs from DELIVERY\.json/));
  test("sealed inputs record differs from its digest", () => refused(fixture({ members: { [DELIVERY_RECORDS.inputs]: "{}" } }).evidence, /inputs record differs from DELIVERY\.json/));
  test("intake member count", () => refused(fixture({ intake: intake => ({ ...intake, members: intake.members - 1 }) }).evidence, /member count/));
});

describe("wrong role and path", () => {
  test("swapped guest role", () => refused(fixture({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, browserGuest: handoff.artifacts.sourceCacheBrowserGuest } }) }).evidence, /handoff differs/));
  test("missing role", () => refused(fixture({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, launcher: undefined } }) }).evidence, /missing launcher/));
  test("extra role", () => refused(fixture({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, tlsPage: handoff.artifacts.webIndex } }) }).evidence, /unknown field tlsPage/));
  test("same bytes at another path", () => refused(fixture({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, browserGuest: { ...handoff.artifacts.browserGuest, path: "/work/tmp/copy/bun-browser.wasm" } } }) }).evidence, /handoff differs/));
  test("relative role path", () => refused(fixture({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, launcher: { ...handoff.artifacts.launcher, path: paths.launcher } } }) }).evidence, /canonical absolute path/));
});

describe("wrong sealed mode", () => {
  test("launcher sealed 0444", async () => { const f = fixture(); chmodSync(join(f.delivery, paths.launcher), 0o444); await refused(f.evidence, /bun-wasm is 0444, expected 0555/); });
  test("payload sealed executable", async () => { const f = fixture(); chmodSync(join(f.delivery, paths.browserGuest), 0o555); await refused(f.evidence, /is 0555, expected 0444/); });
  test("payload with an added write bit", async () => { const f = fixture(); chmodSync(join(f.delivery, paths.sourceArchive), 0o644); await refused(f.evidence, /is 0644, expected 0444/); });
  test("payload with a special bit", async () => { const f = fixture(); chmodSync(join(f.delivery, paths.launcher), 0o4555); await refused(f.evidence, /is 04555, expected 0555/); });
  test("writable directory", async () => { const f = fixture(); chmodSync(join(f.delivery, "split/dist"), 0o755); await refused(f.evidence, /sealed directory split\/dist has mode 0755/); });
  test("writable delivery root", async () => { const f = fixture(); chmodSync(f.delivery, 0o755); await refused(f.evidence, /sealed directory \. has mode 0755/); });
  test("writable DELIVERY.json", async () => { const f = fixture(); chmodSync(join(f.delivery, "DELIVERY.json"), 0o644); await refused(f.evidence, /DELIVERY\.json is not sealed 0444/); });
});

describe("wrong hash and tampered handoff", () => {
  test("changed member bytes", async () => {
    const f = fixture();
    tamper(f, paths.sourceArchive, path => { chmodSync(path, 0o644); writeFileSync(path, "tampered"); chmodSync(path, 0o444); });
    await refused(f.evidence, /delivery member changed: source\.tar\.gz/);
  });
  test("symlink in the delivery", async () => {
    const f = fixture();
    tamper(f, "extra", path => symlinkSync(paths.sourceArchive, path));
    await refused(f.evidence, /symlink or special file/);
  });
  test("custody snapshots differ", () => refused(fixture({ members: { "inputs/vendor-custody-after.json": "changed custody" } }).evidence, /custody mismatch/));
  test("delivered runtime archive is not the authenticated input", () => refused(fixture({ members: { [paths.runtimeArchive]: "other runtime bytes" } }).evidence, /runtime or relay archive differs/));
  test("handoff edited after the controller wrote it", async () => {
    const f = fixture();
    rewriteJson(f.handoff, value => ({ ...value, source: other }));
    await refused(f.evidence, /handoff differs/);
  });
  test("handoff dependency claims differ from the sealed inputs", () => refused(fixture({ handoff: handoff => ({ ...handoff, dependencies: { ...handoff.dependencies, tls: { status: "unresolved", missing: "claimed" } } }) }).evidence, /handoff differs/));
  test("missing handoff", async () => { const f = fixture(); rmSync(f.handoff); await refused(f.evidence, /expected an absolute regular file/); });
});

describe("wrong dependency and missing requirements", () => {
  test("unresolved TLS dependencies", async () => {
    const f = fixture({ inputs: inputs => ({ ...inputs, consumers: { ...inputs.consumers, tls: { status: "unresolved", missing: "pg not authenticated" } } }) });
    await refused(f.evidence, /TLS dependencies unresolved: pg not authenticated/);
    await expect(preflightTls(f.evidence)).rejects.toHaveProperty("code", "TLS_EXISTING_INPUT_CONTRACT_MISSING");
  });
  test("pg project files not beside node_modules", () => refused(fixture({ inputs: withTls(tls => ({ pgLock: tls.pgPackageJson })) }).evidence, /beside its node_modules/));
  test("changed pg tarball", async () => {
    const f = fixture();
    const tls = f.inputs.consumers.tls;
    if (tls.status !== "resolved") throw new Error("fixture TLS dependencies are resolved");
    appendFileSync(tls.value.pgTarball.path, "x");
    await refused(f.evidence, /pg public tarball changed/);
  });
  test("pg tarball that is not the installed pg", () => refused(fixture({ inputs: withTls((_, root) => {
    mkdirSync(join(root, "pg-other/package"), { recursive: true });
    writeFileSync(join(root, "pg-other/package/package.json"), JSON.stringify({ name: "pg", version: "8.16.3", modified: true }));
    execFileSync("tar", ["-czf", join(root, "pg-other.tgz"), "-C", join(root, "pg-other"), "package"]);
    return { pgTarball: fileIdentity(join(root, "pg-other.tgz")) };
  }) }).evidence, /Staged pg differs from the pinned public tarball/));
  test("extra unauthenticated pg file", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "pg-project/node_modules/pg-protocol/extra.ts"), "not authenticated");
    await refused(f.evidence, /pg dependency tree changed/);
  });
  test("changed transitive pg bytes", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "pg-project/node_modules/pg-protocol/index.ts"), "changed transitive bytes");
    await refused(f.evidence, /pg dependency tree changed/);
  });
  test("link inside the pg tree", async () => {
    const f = fixture();
    symlinkSync("../pg/package.json", join(f.root, "pg-project/node_modules/pg-protocol/link"));
    await refused(f.evidence, /symlink or special file/);
  });
  test("missing pg tree", async () => {
    const f = fixture();
    rmSync(join(f.root, "pg-project/node_modules"), { recursive: true });
    await refused(f.evidence, /Missing authenticated pg dependency tree/);
  });
  test("staged host tree differs from its donor", async () => {
    const f = fixture();
    writeFileSync(join(f.host, "web/node_modules/waffle-relay/node.ts"), "changed ignored host code");
    await refused(f.evidence, /staged webDependencies differs from its donor/);
  });
  test("missing staged host tree", async () => {
    const f = fixture();
    rmSync(join(f.host, "node_modules"), { recursive: true });
    await refused(f.evidence, /Missing authenticated host rootDependencies dependency tree/);
  });
  test("changed original donor", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "donors/rootDependencies/node_modules/playwright/package.json"), "{}");
    await refused(f.evidence, /donor tree changed/);
  });
  test("donor not installed from the reviewed frozen lock", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "donors/webDependencies/bun.lock"), "another lock");
    await refused(f.evidence, /webDependencies was not installed from the reviewed frozen bun\.lock/);
  });
  test("changed Playwright browsers", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "dependencies/browsers/entry"), "changed");
    await refused(f.evidence, /Playwright browsers tree changed/);
  });
});

describe("after preflight", () => {
  test("mutation rejects the guest artifact before use", async () => {
    const f = fixture();
    const intake = await admitted(f.evidence);
    const [guest] = guestArtifacts(intake.handoff, "browser");
    if (!guest) throw new Error("browser guest role missing");
    await readVerifiedFile(guest);
    tamper(f, paths.browserGuest, path => { chmodSync(path, 0o644); writeFileSync(path, "mutated guest bytes"); });
    await expect(readVerifiedFile(guest)).rejects.toThrow("byte/custody mismatch");
  });
  test("dependency mutation is caught by the recheck and before seeding", async () => {
    const f = fixture();
    const intake = await admitted(f.evidence);
    const dependency = intake.dependencies.pg.files.find(row => row.path.endsWith("pg-protocol/index.ts"));
    if (!dependency) throw new Error("Parser control dependency missing");
    await recheckDependencies(intake);
    writeFileSync(dependency.path, "changed after preflight");
    await expect(recheckDependencies(intake)).rejects.toThrow("tree changed");
    await expect(readVerifiedFile(dependency)).rejects.toThrow("before use");
  });
  test("host lock mutation is caught by the recheck", async () => {
    const f = fixture();
    const intake = await admitted(f.evidence);
    writeFileSync(join(f.root, "pg-project/bun.lock"), "changed lock");
    await expect(recheckDependencies(intake)).rejects.toThrow("pg-project/bun.lock");
  });
  test("tracked source mutation is rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "bun-wasm-tls-host-source-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "tracked.ts"), "original");
      execFileSync("git", ["-C", root, "add", "tracked.ts"]);
      execFileSync("git", ["-C", root, "-c", "user.email=tls@test.invalid", "-c", "user.name=TLS test", "commit", "-qm", "source"]);
      const expected = { head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), tree: execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim() };
      await writeFile(join(root, "tracked.ts"), "mutated");
      await expect(verifyReviewedHostSource(root, expected)).rejects.toThrow("clean reviewed source");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("result source includes exact host dependency projections and bound", async () => {
    const page = await readFile(new URL("../web/tests/tls-relay-browser.ts", import.meta.url), "utf8");
    expect(page).toContain("hostDependencies: intake.dependencies.host");
    expect(page).toContain("frozenLocks: intake.dependencies.locks");
    expect(page).toContain("guestArtifacts(intake.handoff, engine)");
    expect(page).not.toContain("split/dist/");
    const cli = await readFile(new URL("./tls-qualification.ts", import.meta.url), "utf8");
    expect(cli).toContain("256 * 1024");
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
    const context = { engine: "browser", carrier: "websocket", connections: 1, lifecycle: { runtimeDisposed: true, liveConsumers: 0, relayActive: 0 }, result };
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
  test("lifecycle booleans without observations are rejected", () => {
    expect(() => assertCaseContext({ engine: "browser", carrier: "websocket", connections: 1, runtimeDisposed: true, relayClosed: true, result }, "verified", "browser")).toThrow(/lifecycle.*observations/i);
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
  test("CLI takes only the handoff, pinned intake and reviewed source as trust inputs", () => {
    const base = ["--stage", "pg-early", "--browser", "chromium", "--intake-sha256", "a".repeat(64), "--reviewed-head", "b".repeat(40), "--reviewed-tree", "c".repeat(40),
      "--database-machine", "pi", "--database-address", "100.64.0.2", "--relay-address", "100.64.0.3"];
    const parsed = parseTlsArguments(base.concat(["--handoff", "/work/tmp/q/handoff.json"]));
    expect(parsed.evidence).toEqual({ handoff: "/work/tmp/q/handoff.json", intakeSha256: "a".repeat(64), reviewedSource: { head: "b".repeat(40), tree: "c".repeat(40) } });
    expect(() => parseTlsArguments(base)).toThrow("--handoff");
    expect(() => parseTlsArguments(base.concat(["--handoff", "q/handoff.json"]))).toThrow("canonical absolute");
    expect(() => parseTlsArguments(base.concat(["--handoff", "/work/tmp/q/../handoff.json"]))).toThrow("canonical absolute");
    for (const old of ["--delivery", "--admission", "--source-release-sha256", "--host-source", "--pg-node-modules", "--pg-tarball", "--output"]) {
      expect(() => parseTlsArguments(base.concat(["--handoff", "/work/tmp/q/handoff.json", old, "/work/tmp/x"]))).toThrow("Unknown");
    }
  });
});

describe("lifecycle observations", () => {
  test("cancellation after validation never calls setup", async () => {
    const abort = new AbortController();
    let setups = 0;
    const validate = async () => { abort.abort(new Error("cancel after validation")); return 1; };
    await expect(qualifiedRun(validate, async () => { setups++; }, async () => {}, abort.signal)).rejects.toThrow("cancel after validation");
    expect(setups).toBe(0);
  });
  test("qualified cleanup releases a late resource after abort", async () => {
    const abort = new AbortController();
    const deferred = Promise.withResolvers<string>();
    const owner = new TlsCleanup();
    let released = false;
    const acquisition = acquireOwned(owner, abort.signal, () => deferred.promise, () => { released = true; });
    abort.abort(new Error("late resource"));
    await expect(acquisition).rejects.toThrow("late resource");
    deferred.resolve("resource");
    await owner.close();
    expect(released).toBe(true);
  });
  test("disposal/close failures and live consumers cannot report success", async () => {
    let closes = 0;
    await expect(closeObservedCase({ dispose: async () => { throw new Error("dispose failed"); }, close: async () => { closes++; }, observe: () => ({ runtimeDisposed: true, liveConsumers: 0, relayActive: 0 }) })).rejects.toThrow("cleanup failed");
    expect(closes).toBe(1);
    await expect(closeObservedCase({ dispose: async () => {}, close: async () => { throw new Error("close failed"); }, observe: () => ({ runtimeDisposed: true, liveConsumers: 0, relayActive: 0 }) })).rejects.toThrow("cleanup failed");
    for (const observations of [{ runtimeDisposed: true, liveConsumers: 1, relayActive: 0 }, { runtimeDisposed: true, liveConsumers: 0, relayActive: 1 }, { runtimeDisposed: false, liveConsumers: 0, relayActive: 0 }, undefined]) {
      await expect(closeObservedCase({ dispose: async () => {}, close: async () => {}, observe: () => observations })).rejects.toThrow("lifecycle observations");
    }
  });
  test("observations happen after both real cleanup callbacks", async () => {
    const events: string[] = [];
    let liveConsumers = 1, relayActive = 1, runtimeDisposed = false;
    const result = await closeObservedCase({ dispose: async () => { liveConsumers--; runtimeDisposed = true; events.push("dispose"); }, close: async () => { relayActive--; events.push("close"); }, observe: () => { events.push("observe"); return { runtimeDisposed, liveConsumers, relayActive }; } });
    expect(result).toEqual({ runtimeDisposed: true, liveConsumers: 0, relayActive: 0 });
    expect(events).toEqual(["dispose", "close", "observe"]);
  });
  test("cancellation before and during every owned acquisition unwinds prior resources", async () => {
    const boundaries = ["remote-owner", "proxy", "listener", "relay", "relay-listener", "page-server", "browser", "context", "page", "guest"];
    const root = await mkdtemp(join(tmpdir(), "bun-wasm-tls-lifecycle-"));
    try {
      for (const during of [false, true]) {
        for (let boundary = 0; boundary < boundaries.length; boundary++) await acquisitionCancellation(root, boundary, during, boundaries);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("abort after setup prevents exercise and still closes its owner", async () => {
    const abort = new AbortController(); let exercised = false, released = false;
    await expect(qualifiedRun(async () => 1, async (_, owner) => {
      await acquireOwned(owner, abort.signal, () => "parser resource", () => { released = true; });
      abort.abort(new Error("after setup"));
    }, async () => { exercised = true; }, abort.signal)).rejects.toThrow("after setup");
    expect(exercised).toBe(false); expect(released).toBe(true);
  });
});
async function acquisitionCancellation(root: string, boundary: number, during: boolean, boundaries: readonly string[]) {
  const abort = new AbortController();
  const acquired: string[] = [], released: string[] = [];
  await expect(qualifiedRun(async () => 1, async (_, owner) => {
    for (const [index, label] of boundaries.entries()) {
      if (index === boundary && !during) abort.abort(new Error("boundary cancelled"));
      await acquireOwned(owner, abort.signal, async () => {
        const path = join(root, `${label}.parser-resource`);
        await writeFile(path, "synthetic lifecycle resource, never a service"); acquired.push(path);
        if (index === boundary && during) abort.abort(new Error("boundary cancelled"));
        return path;
      }, async path => { await rm(path); released.push(path); });
    }
  }, async () => {}, abort.signal)).rejects.toThrow("boundary cancelled");
  expect(acquired).toHaveLength(boundary + Number(during));
  expect(released).toEqual(acquired.toReversed());
  for (const path of acquired) await expect(readFile(path)).rejects.toHaveProperty("code", "ENOENT");
}
