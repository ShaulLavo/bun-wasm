import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { FirstFailure, TlsQualificationFailure, formatTlsFailure, parseTlsArguments, runTlsCli } from "./tls-qualification.ts";
import {
  TLS_STAGE, guestArtifacts, preflightTls, readVerifiedFile, recheckDependencies, requireInstalledRuntimePackage, tlsLoaded, tlsReleaseTuple, verifyReviewedHostSource,
  type ObservedResponse, type TlsEvidence, type TlsIntake,
} from "./tls-qualification-inputs.ts";
import { qualifiedRun, TlsCleanup, acquireOwned, closeObservedCase } from "./tls-qualification-lifecycle.ts";
import { qualificationCases, assertCaseContext, assertPgResult } from "./tls-qualification-context.ts";
import { qualificationFixture, type FixtureOverrides, type TlsFixture } from "./tls-qualification-fixture.ts";
import { handoffMemberPaths, tlsPagePaths } from "./producer-closure.ts";
import { DELIVERY_RECORDS, type InputManifest } from "./c1/contract.ts";
import { FIXTURE_TLS_OPTIONS, FIXTURE_TUPLE } from "./c1/contract-fixture.ts";
import { fileIdentity } from "./c1/identity.ts";
import { UNRESOLVED_RELAY } from "./c1/tls-page.ts";
import { PgWireAudit } from "../web/tests/tls-relay-services.ts";
import { piPostgresPlan, assertPiPostgresImage, removePiPostgres, type PodmanRun } from "../tests/servers/tls.ts";

/**
 * Every fixture here is synthetic parser data built from the controller's
 * exported contract, fixture, page and seal functions. None of it is product evidence.
 */
const fixtures: TlsFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
async function fixture(overrides?: FixtureOverrides): Promise<TlsFixture> {
  const created = await qualificationFixture(overrides);
  fixtures.push(created);
  return created;
}
/** Preflight refuses and setup never runs. */
async function refused(evidence: TlsEvidence, expected: RegExp | string): Promise<void> {
  let setups = 0;
  await expect(qualifiedRun(() => preflightTls(evidence), async () => { setups++; }, async () => {})).rejects.toThrow(expected);
  expect(setups).toBe(0);
}
async function refusedWith(overrides: FixtureOverrides, expected: RegExp | string): Promise<void> {
  let setups = 0;
  await expect(qualifiedRun(async () => preflightTls((await fixture(overrides)).evidence), async () => { setups++; }, async () => {})).rejects.toThrow(expected);
  expect(setups).toBe(0);
}
function refusedTuple(change: Partial<typeof FIXTURE_TUPLE>, expected: RegExp): Promise<void> {
  const tuple = { ...FIXTURE_TUPLE, ...change };
  return refusedWith({ tuple, inputs: inputs => ({ ...inputs, tuple }) }, expected);
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
  test("an exact pinned handoff reaches setup with registry identities, modes, fixture options, page and dependencies", async () => {
    const f = await fixture();
    const launcher = join(f.delivery, paths.launcher);
    const before = lstatSync(launcher);
    const intake = await admitted(f.evidence);
    expect(intake.tuple).toEqual(tlsReleaseTuple);
    expect(intake.source).toEqual(f.source);
    expect(intake.handoff.artifacts.launcher.path).toBe(launcher);
    expect(intake.output).toBe(join(f.root, "qualification/tls", TLS_STAGE));
    expect(intake.hostSource).toBe(f.host);
    expect(intake.fixtures).toEqual(FIXTURE_TLS_OPTIONS);
    expect(intake.page.map(row => relative(intake.handoff.tlsPageRoot, row.path)).toSorted()).toEqual(["chunks/shared.js", "fs-worker.js", "index.html", "notification-worker.js", "tls-relay-page.js", "worker.js"]);
    expect(intake.references).toHaveLength(17);
    expect(intake.references.map(row => row.path)).toEqual(expect.arrayContaining([f.handoff, f.intake, join(f.delivery, tlsPagePaths.receipt), join(f.delivery, "inputs/native-custody-preseal.json")]));
    expect(intake.dependencies.pg.files.map(row => relative(intake.dependencies.pg.root, row.path))).toEqual(["pg-protocol/index.ts", "pg/lib/index.ts", "pg/package.json"]);
    expect(intake.dependencies.host.map(tree => tree.path)).toEqual([join(f.host, "node_modules"), join(f.host, "web/node_modules")]);
    expect(intake.dependencies.locks).toHaveLength(6);
    const after = lstatSync(launcher);
    expect([after.mode & 0o7777, after.ctimeMs, after.ino]).toEqual([0o555, before.ctimeMs, before.ino]);
  });
  test("guest roles come from the controller registry, not copied paths", async () => {
    const { handoff } = await admitted((await fixture()).evidence);
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

describe("pinned handoff and output", () => {
  test("handoff bytes differ from the caller's pin", async () => {
    const f = await fixture();
    rewriteJson(f.handoff, value => ({ ...value, source: other }));
    await refused(f.evidence, /handoff bytes differ from the pinned SHA-256/);
  });
  test("pinned but edited handoff differs from the derived one", () => refusedWith({ handoff: handoff => ({ ...handoff, webRoot: join(handoff.webRoot, "other") }) }, /handoff differs/));
  test("missing handoff", async () => { const f = await fixture(); rmSync(f.handoff); await refused(f.evidence, /ENOENT/); });
  test("intake bytes changed after the handoff pinned them", async () => {
    const f = await fixture();
    rewriteJson(f.intake, value => value);
    await refused(f.evidence, /intake record bytes differ from the pinned SHA-256/);
  });
  test("output outside the handoff's stage directory", async () => { const f = await fixture(); await refused({ ...f.evidence, output: "/work/tmp/tls-foreign/pg-early" }, /pg-early directory beneath outputs\.tls/); });
  test("output at outputs.tls itself, where the controller's DriverRun.out reads result.json", async () => {
    const f = await fixture();
    await refused({ ...f.evidence, output: dirname(f.evidence.output) }, /pg-early directory beneath outputs\.tls/);
  });
});

describe("wrong schema", () => {
  test("handoff schema", () => refusedWith({ handoff: handoff => ({ ...handoff, schema: "bun-wasm.c1-handoff/0" }) }, /handoff\.schema/));
  test("intake schema", () => refusedWith({ intake: intake => ({ ...intake, schema: "bun-wasm.c1-intake/0" }) }, /intake\.schema/));
  test("old parent byte admission shape", () => refusedWith({ intake: intake => ({ kind: intake.kind, owner: intake.owner, parentByteIntakePassed: true, packetBytesAdmitted: true, source: intake.source, deliveryRoot: intake.deliveryRoot, tuple: { ...intake.tuple, engines: ["quickjs", "jsc", "browser"] } }) }, /intake: unknown field/));
  test("old ADMISSION.json added after sealing", async () => {
    const f = await fixture();
    tamper(f, "inputs/ADMISSION.json", path => writeFileSync(path, "{}"));
    await refused(f.evidence, /missing or extra files/);
  });
  test("engine build registry shape", () => refusedWith({ members: { [paths.engineBuilds]: "{}" } }, /Publication asset registry/));
});

describe("fixture options", () => {
  test("unresolved options are a missing contract input", async () => {
    const f = await fixture({ config: config => ({ ...config, fixtures: { tls: { status: "unresolved", missing: "database host not admitted" } } }) });
    await refused(f.evidence, /TLS fixture options unresolved: database host not admitted/);
    await expect(preflightTls(f.evidence)).rejects.toHaveProperty("code", "TLS_EXISTING_INPUT_CONTRACT_MISSING");
  });
  test("handoff options other than the sealed config's", () => refusedWith({ handoff: handoff => ({ ...handoff, fixtures: { tls: { status: "resolved", value: { ...FIXTURE_TLS_OPTIONS, pagePort: 43841 } } } }) }, /handoff differs/));
  test("handoff options with a secret field", () => refusedWith({ handoff: handoff => ({ ...handoff, fixtures: { tls: { status: "resolved", value: { ...FIXTURE_TLS_OPTIONS, password: "x" } } } }) }, /unknown field password/));
  test("handoff options with a public database address", () => refusedWith({ handoff: handoff => ({ ...handoff, fixtures: { tls: { status: "resolved", value: { ...FIXTURE_TLS_OPTIONS, databaseAddress: "8.8.8.8" } } } }) }, /private fleet address/));
});

describe("sealed TLS page", () => {
  test("a page member that differs from its receipt", () => refusedWith({ members: { [tlsPagePaths.entry]: `const entry = "${UNRESOLVED_RELAY}"; await import(entry);\n` } }, /TLS page files differ from its receipt/));
  test("a changed page byte after sealing", async () => {
    const f = await fixture();
    tamper(f, tlsPagePaths.workers[0] ?? "", path => { chmodSync(path, 0o644); writeFileSync(path, "changed worker"); chmodSync(path, 0o444); });
    await refused(f.evidence, /delivery member changed: tls\/page\/worker\.js/);
  });
  test("a bundled host input changed after the page was built", async () => {
    const f = await fixture();
    for (const root of [join(f.root, "donors/webDependencies/node_modules"), join(f.host, "web/node_modules")]) writeFileSync(join(root, "waffle/package.json"), JSON.stringify({ version: "0.0.110", changed: true }));
    await refused(f.evidence, /donor tree changed/);
  });
});

describe("wrong root", () => {
  test("intake names another delivery root", () => refusedWith({ intake: intake => ({ ...intake, deliveryRoot: join(dirname(intake.deliveryRoot), "other") }) }, /intake names a different delivery/));
  test("sealed config places the delivery elsewhere", () => refusedWith({ config: config => ({ ...config, roots: { ...config.roots, run: { ...config.roots.run, artifact: join(config.roots.run.artifact, "elsewhere") } } }) }, /delivery root differs from its sealed config/));
  test("handoff TLS page root", () => refusedWith({ handoff: handoff => ({ ...handoff, tlsPageRoot: join(handoff.tlsPageRoot, "other") }) }, /handoff differs/));
  test("handoff TLS output outside the sealed qualification root", () => refusedWith({ handoff: handoff => ({ ...handoff, outputs: { ...handoff.outputs, tls: "/work/tmp/foreign-tls" } }) }, /handoff differs/));
  test("handoff browser scratch", () => refusedWith({ handoff: handoff => ({ ...handoff, browserTmp: "/work/tmp/other" }) }, /handoff differs/));
});

describe("wrong source", () => {
  test("handoff claims another source", () => refusedWith({ handoff: handoff => ({ ...handoff, source: other }) }, /handoff differs/));
  test("intake source", () => refusedWith({ intake: intake => ({ ...intake, source: other }) }, /intake source or tuple differs/));
  test("sealed inputs select another source", () => refusedWith({ inputs: inputs => ({ ...inputs, source: other }) }, /sealed inputs select another source or tuple/));
  test("delivery of another source than the host", () => refusedWith({ deliverySource: other }, /sealed inputs select another source/));
  test("dirty host checkout", async () => {
    const f = await fixture();
    writeFileSync(join(f.host, "untracked.ts"), "export {};\n");
    await refused(f.evidence, /clean reviewed source/);
  });
  test("host checkout at another commit", async () => {
    const f = await fixture();
    execFileSync("git", ["-C", f.host, "-c", "user.email=tls@test.invalid", "-c", "user.name=TLS fixture", "commit", "-q", "--allow-empty", "-m", "moved"]);
    await refused(f.evidence, /differs from reviewed TLS source/);
  });
});

describe("wrong tuple", () => {
  test("runtime109 delivery", () => refusedTuple({ runtime: "0.0.109" }, /runtime110\/relay109/));
  test("runtime107 delivery", () => refusedTuple({ runtime: "0.0.107" }, /runtime110\/relay109/));
  test("other programs release", () => refusedTuple({ programs: "programs-v0.0.14" }, /programs15/));
  test("other program manifest schema", () => refusedTuple({ programManifestSchema: "waffle-program-release/1" }, /schema2/));
  test("intake tuple", () => refusedWith({ intake: intake => ({ ...intake, tuple: { ...intake.tuple, hostInterface: 2 } }) }, /intake source or tuple differs/));
  test("installed runtime and relay packages", () => {
    expect(() => requireInstalledRuntimePackage("waffle", { version: "0.0.110" })).not.toThrow();
    expect(() => requireInstalledRuntimePackage("waffle-relay", { version: "0.0.109" })).not.toThrow();
    expect(() => requireInstalledRuntimePackage("waffle", { version: "0.0.109" })).toThrow("runtime110/relay109");
    expect(() => requireInstalledRuntimePackage("waffle-relay", { version: "0.0.110" })).toThrow("runtime110/relay109");
  });
});

describe("wrong manifest and count", () => {
  test("intake names other DELIVERY.json bytes", () => refusedWith({ intake: intake => ({ ...intake, delivery: { ...intake.delivery, sha256: "e".repeat(64) } }) }, /different DELIVERY\.json/));
  test("sealed config names another input manifest", () => refusedWith({ config: config => ({ ...config, manifest: { ...config.manifest, sha256: "a".repeat(64) } }) }, /names another input manifest/));
  test("sealed config record differs from its digest", () => refusedWith({ members: { [DELIVERY_RECORDS.config]: "{}" } }, /sealed config record differs from the digest DELIVERY\.json binds/));
  test("sealed inputs record differs from its digest", () => refusedWith({ members: { [DELIVERY_RECORDS.inputs]: "{}" } }, /sealed inputs record differs from the digest DELIVERY\.json binds/));
  test("intake member count", () => refusedWith({ intake: intake => ({ ...intake, members: intake.members - 1 }) }, /member count/));
});

describe("wrong role and path", () => {
  test("swapped guest role", () => refusedWith({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, browserGuest: handoff.artifacts.sourceCacheBrowserGuest } }) }, /handoff differs/));
  test("swapped TLS page role", () => refusedWith({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, tlsPageEntry: handoff.artifacts.tlsPageIndex } }) }, /handoff differs/));
  test("missing role", () => refusedWith({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, launcher: undefined } }) }, /missing launcher/));
  test("extra role", () => refusedWith({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, tlsHostPage: handoff.artifacts.webIndex } }) }, /unknown field tlsHostPage/));
  test("same bytes at another path", () => refusedWith({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, browserGuest: { ...handoff.artifacts.browserGuest, path: "/work/tmp/copy/bun-browser.wasm" } } }) }, /handoff differs/));
  test("relative role path", () => refusedWith({ handoff: handoff => ({ ...handoff, artifacts: { ...handoff.artifacts, launcher: { ...handoff.artifacts.launcher, path: paths.launcher } } }) }, /canonical absolute path/));
});

describe("wrong sealed mode", () => {
  test("launcher sealed 0444", async () => { const f = await fixture(); chmodSync(join(f.delivery, paths.launcher), 0o444); await refused(f.evidence, /bun-wasm is 0444, expected 0555/); });
  test("payload sealed executable", async () => { const f = await fixture(); chmodSync(join(f.delivery, paths.browserGuest), 0o555); await refused(f.evidence, /is 0555, expected 0444/); });
  test("page script sealed executable", async () => { const f = await fixture(); chmodSync(join(f.delivery, tlsPagePaths.entry), 0o555); await refused(f.evidence, /tls-relay-page\.js is 0555, expected 0444/); });
  test("payload with an added write bit", async () => { const f = await fixture(); chmodSync(join(f.delivery, paths.sourceArchive), 0o644); await refused(f.evidence, /is 0644, expected 0444/); });
  test("payload with a special bit", async () => { const f = await fixture(); chmodSync(join(f.delivery, paths.launcher), 0o4555); await refused(f.evidence, /is 04555, expected 0555/); });
  test("writable directory", async () => { const f = await fixture(); chmodSync(join(f.delivery, "split/dist"), 0o755); await refused(f.evidence, /sealed directory split\/dist has mode 0755/); });
  test("writable page directory", async () => { const f = await fixture(); chmodSync(join(f.delivery, tlsPagePaths.root), 0o755); await refused(f.evidence, /sealed directory tls\/page has mode 0755/); });
  test("writable delivery root", async () => { const f = await fixture(); chmodSync(f.delivery, 0o755); await refused(f.evidence, /sealed directory \. has mode 0755/); });
  test("writable DELIVERY.json", async () => { const f = await fixture(); chmodSync(join(f.delivery, "DELIVERY.json"), 0o644); await refused(f.evidence, /DELIVERY\.json is not sealed 0444/); });
});

describe("wrong hash", () => {
  test("changed member bytes", async () => {
    const f = await fixture();
    tamper(f, paths.sourceArchive, path => { chmodSync(path, 0o644); writeFileSync(path, "tampered"); chmodSync(path, 0o444); });
    await refused(f.evidence, /delivery member changed: source\.tar\.gz/);
  });
  test("symlink in the delivery", async () => {
    const f = await fixture();
    tamper(f, "extra", path => symlinkSync(paths.sourceArchive, path));
    await refused(f.evidence, /symlink or special file/);
  });
  test("custody snapshots differ", () => refusedWith({ members: { "inputs/vendor-custody-after.json": "changed custody" } }, /custody mismatch/));
  test("delivered runtime archive is not the authenticated input", () => refusedWith({ members: { [paths.runtimeArchive]: "other runtime bytes" } }, /runtime or relay archive differs/));
  test("handoff dependency claims differ from the sealed inputs", () => refusedWith({ handoff: handoff => ({ ...handoff, dependencies: { ...handoff.dependencies, tls: { status: "unresolved", missing: "claimed" } } }) }, /handoff differs/));
});

describe("wrong dependency and missing requirements", () => {
  test("unresolved TLS dependencies", async () => {
    const f = await fixture({ inputs: inputs => ({ ...inputs, consumers: { ...inputs.consumers, tls: { status: "unresolved", missing: "pg not authenticated" } } }) });
    await refused(f.evidence, /TLS dependencies unresolved: pg not authenticated/);
    await expect(preflightTls(f.evidence)).rejects.toHaveProperty("code", "TLS_EXISTING_INPUT_CONTRACT_MISSING");
  });
  test("pg project files not beside node_modules", () => refusedWith({ inputs: withTls(tls => ({ pgLock: tls.pgPackageJson })) }, /beside its node_modules/));
  test("changed pg tarball", async () => {
    const f = await fixture();
    const tls = f.inputs.consumers.tls;
    if (tls.status !== "resolved") throw new Error("fixture TLS dependencies are resolved");
    appendFileSync(tls.value.pgTarball.path, "x");
    await refused(f.evidence, /pg public tarball changed/);
  });
  test("pg tarball that is not the installed pg", () => refusedWith({ inputs: withTls((_, root) => {
    mkdirSync(join(root, "pg-other/package"), { recursive: true });
    writeFileSync(join(root, "pg-other/package/package.json"), JSON.stringify({ name: "pg", version: "8.16.3", modified: true }));
    execFileSync("tar", ["-czf", join(root, "pg-other.tgz"), "-C", join(root, "pg-other"), "package"]);
    return { pgTarball: fileIdentity(join(root, "pg-other.tgz")) };
  }) }, /Staged pg differs from the pinned public tarball/));
  test("extra unauthenticated pg file", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "pg-project/node_modules/pg-protocol/extra.ts"), "not authenticated");
    await refused(f.evidence, /pg dependency tree changed/);
  });
  test("changed transitive pg bytes", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "pg-project/node_modules/pg-protocol/index.ts"), "changed transitive bytes");
    await refused(f.evidence, /pg dependency tree changed/);
  });
  test("link inside the pg tree", async () => {
    const f = await fixture();
    symlinkSync("../pg/package.json", join(f.root, "pg-project/node_modules/pg-protocol/link"));
    await refused(f.evidence, /symlink or special file/);
  });
  test("missing pg tree", async () => {
    const f = await fixture();
    rmSync(join(f.root, "pg-project/node_modules"), { recursive: true });
    await refused(f.evidence, /Missing authenticated pg dependency tree/);
  });
  test("staged host tree differs from its donor", async () => {
    const f = await fixture();
    writeFileSync(join(f.host, "web/node_modules/waffle-relay/node.ts"), "changed ignored host code");
    await refused(f.evidence, /staged webDependencies differs from its donor/);
  });
  test("missing staged host tree", async () => {
    const f = await fixture();
    rmSync(join(f.host, "node_modules"), { recursive: true });
    await refused(f.evidence, /Missing authenticated host rootDependencies dependency tree/);
  });
  test("changed original donor", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "donors/rootDependencies/node_modules/playwright/package.json"), "{}");
    await refused(f.evidence, /donor tree changed/);
  });
  test("donor not installed from the reviewed frozen lock", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "donors/webDependencies/bun.lock"), "another lock");
    await refused(f.evidence, /webDependencies was not installed from the reviewed frozen bun\.lock/);
  });
  test("changed Playwright browsers", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "dependencies/browsers/entry"), "changed");
    await refused(f.evidence, /Playwright browsers tree changed/);
  });
});

/** What the real page would observe for admitted members: decoded bodies from their sealed or authenticated files. */
function responses(intake: TlsIntake): ObservedResponse[] {
  const origin = `http://127.0.0.1:${intake.fixtures.pagePort}`;
  const get = (path: string, file: string): ObservedResponse => ({ url: `${origin}${path}`, method: "GET", status: 200, contentEncoding: undefined, body: readFileSync(file) });
  const guest = intake.handoff.artifacts.browserGuest;
  const pg = intake.dependencies.pg.files.find(row => row.path.endsWith("pg/package.json"));
  if (!pg) throw new Error("fixture pg package missing");
  return intake.page.map(row => get(row.path.endsWith("/index.html") ? "/" : `/${relative(intake.handoff.tlsPageRoot, row.path)}`, row.path)).concat([
    get("/pg-client.ts", intake.handoff.artifacts.tlsPgClient.path), get(`/artifact/${guest.sha256}`, guest.path), get("/seed/node_modules/pg/package.json", pg.path),
    { url: `${origin}/seed`, method: "GET", status: 200, contentEncoding: undefined, body: new TextEncoder().encode("[]") },
    { url: `${origin}/favicon.ico`, method: "GET", status: 404, contentEncoding: undefined, body: new Uint8Array() },
    { url: `${origin}/case/verified`, method: "POST", status: 200, contentEncoding: undefined, body: new TextEncoder().encode('{"password":"never loaded"}') },
  ]);
}
describe("loaded observations use the controller's type and validator", () => {
  test("real successful GET responses become bound loaded rows; failures and POST controls do not", async () => {
    const intake = await admitted((await fixture()).evidence);
    const { loaded, unloaded } = tlsLoaded(intake.handoff, responses(intake));
    expect(loaded).toHaveLength(intake.page.length + 4);
    expect(loaded.every(row => row.method === "GET" && row.status === 200 && row.encoding === "identity")).toBe(true);
    expect(loaded.map(row => new URL(row.url).pathname)).toEqual(expect.arrayContaining(["/", "/tls-relay-page.js", "/worker.js", "/pg-client.ts", "/seed"]));
    expect(unloaded).toEqual([{ url: `http://127.0.0.1:${FIXTURE_TLS_OPTIONS.pagePort}/favicon.ico`, status: 404 }]);
    expect(JSON.stringify(loaded)).not.toContain("never loaded");
  });
  const change = (rows: ObservedResponse[], path: string, edit: Partial<ObservedResponse>) => rows.map(row => new URL(row.url).pathname === path ? { ...row, ...edit } : row);
  test.each([
    ["changed page bytes", (rows: ObservedResponse[]) => change(rows, "/tls-relay-page.js", { body: new TextEncoder().encode("other") }), "differ from the admitted member"],
    ["a claimed gzip page without that representation", (rows: ObservedResponse[]) => change(rows, "/worker.js", { contentEncoding: "gzip" }), "no admitted gzip representation"],
    ["an unknown encoding", (rows: ObservedResponse[]) => change(rows, "/worker.js", { contentEncoding: "zstd" }), "successful GET"],
    ["an unadmitted script", (rows: ObservedResponse[]) => rows.concat([{ ...rows[0]!, url: rows[0]!.url.replace(/\/[^/]*$/, "/evil.js") }]), "not an admitted member"],
    ["a foreign origin", (rows: ObservedResponse[]) => rows.map(row => ({ ...row, url: row.url.replace("127.0.0.1", "cdn.example.com") })), "loopback"],
    ["a seed outside the admitted pg tree", (rows: ObservedResponse[]) => change(rows, "/seed/node_modules/pg/package.json", { url: rows[0]!.url.replace(/\/[^/]*$/, "/seed/node_modules/other/package.json") }), "not an admitted member"],
    ["no WebAssembly", (rows: ObservedResponse[]) => rows.filter(row => !row.url.includes("/artifact/")), "no WebAssembly"],
  ])("observations with %s refuse", async (_name, edit, message) => {
    const intake = await admitted((await fixture()).evidence);
    expect(() => tlsLoaded(intake.handoff, edit(responses(intake)))).toThrow(message);
  });
});

describe("post-preflight mode and browser rechecks", () => {
  test("a changed Chromium tree refuses the pre-launch recheck", async () => {
    const intake = await admitted((await fixture()).evidence);
    await recheckDependencies(intake);
    writeFileSync(join(intake.handoff.dependencies.browsers.path, "entry"), "changed browser bytes");
    await expect(recheckDependencies(intake)).rejects.toThrow("Playwright browsers tree changed");
  });
  test("a writable sealed worker refuses every delivered read without repair", async () => {
    const f = await fixture();
    const intake = await admitted(f.evidence);
    const worker = intake.page.find(row => row.path.endsWith("/fs-worker.js"));
    if (!worker) throw new Error("fixture worker missing");
    const before = lstatSync(worker.path);
    await readVerifiedFile(worker, f.delivery);
    expect(lstatSync(worker.path).ctimeMs).toBe(before.ctimeMs);
    chmodSync(worker.path, 0o644);
    await expect(readVerifiedFile(worker, f.delivery)).rejects.toThrow("sealed file mode");
    expect(lstatSync(worker.path).mode & 0o7777).toBe(0o644);
  });
  test.each(["page ancestor", "delivery root"])("a writable %s refuses delivered reads", async location => {
    const f = await fixture();
    const intake = await admitted(f.evidence);
    const worker = intake.page.find(row => row.path.endsWith("/fs-worker.js"));
    if (!worker) throw new Error("fixture worker missing");
    const directory = location === "page ancestor" ? intake.handoff.tlsPageRoot : f.delivery;
    chmodSync(directory, 0o755);
    await expect(readVerifiedFile(worker, f.delivery)).rejects.toThrow("sealed directory mode");
    expect(lstatSync(directory).mode & 0o7777).toBe(0o755);
  });
  test.each(["browserGuest", "tlsPgClient"] as const)("wrong %s mode refuses without byte mutation", async role => {
    const f = await fixture();
    const intake = await admitted(f.evidence);
    const file = intake.handoff.artifacts[role];
    chmodSync(file.path, 0o555);
    await expect(readVerifiedFile(file, f.delivery)).rejects.toThrow("sealed file mode");
    expect(lstatSync(file.path).mode & 0o7777).toBe(0o555);
  });
  test("registry launcher mode is accepted without changing metadata", async () => {
    const f = await fixture();
    const intake = await admitted(f.evidence);
    const file = intake.handoff.artifacts.launcher;
    const before = lstatSync(file.path);
    expect((await readVerifiedFile(file, f.delivery)).byteLength).toBe(file.bytes);
    const after = lstatSync(file.path);
    expect([after.mode, after.ctimeMs, after.ino]).toEqual([before.mode, before.ctimeMs, before.ino]);
  });
  test("delivered reads reject special bits and paths outside their root", async () => {
    const f = await fixture();
    const intake = await admitted(f.evidence);
    const file = intake.handoff.artifacts.launcher;
    chmodSync(file.path, 0o4555);
    await expect(readVerifiedFile(file, f.delivery)).rejects.toThrow("sealed file mode");
    await expect(readVerifiedFile(intake.pgArchive, f.delivery)).rejects.toThrow("outside");
  });
});

describe("after preflight", () => {
  test("mutation rejects the guest artifact before use", async () => {
    const f = await fixture();
    const intake = await admitted(f.evidence);
    const [guest] = guestArtifacts(intake.handoff, "browser");
    if (!guest) throw new Error("browser guest role missing");
    await readVerifiedFile(guest);
    tamper(f, paths.browserGuest, path => { chmodSync(path, 0o644); writeFileSync(path, "mutated guest bytes"); });
    await expect(readVerifiedFile(guest)).rejects.toThrow("byte/custody mismatch");
  });
  test("dependency mutation is caught by the recheck and before seeding", async () => {
    const intake = await admitted((await fixture()).evidence);
    const dependency = intake.dependencies.pg.files.find(row => row.path.endsWith("pg-protocol/index.ts"));
    if (!dependency) throw new Error("Parser control dependency missing");
    await recheckDependencies(intake);
    writeFileSync(dependency.path, "changed after preflight");
    await expect(recheckDependencies(intake)).rejects.toThrow("tree changed");
    await expect(readVerifiedFile(dependency)).rejects.toThrow("before use");
  });
  test("frozen lock mutation is caught by the recheck", async () => {
    const f = await fixture();
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
  test("the consumer serves sealed members only and never builds", async () => {
    const browser = await readFile(new URL("../web/tests/tls-relay-browser.ts", import.meta.url), "utf8");
    for (const expected of ["hostDependencies: intake.dependencies.host", "frozenLocks: intake.dependencies.locks", "guestArtifacts(intake.handoff, engine)", "tlsLoaded(intake.handoff", "pageMembers: intake.page", "intake.handoff.artifacts.tlsPgClient", "readVerifiedFile(file, sealedRoot)", "readVerifiedFile(artifact, sealedRoot)", "readVerifiedFile(member, sealedRoot)", "readVerifiedFile(intake.handoff.artifacts.tlsPgClient, sealedRoot)"]) expect(browser).toContain(expected);
    for (const forbidden of ["buildBrowserEntries", "Bun.build", "browser-build", "symlink", "fixtures/tls/pg-client.ts", "split/dist/"]) expect(browser).not.toContain(forbidden);
    const cli = await readFile(new URL("./tls-qualification.ts", import.meta.url), "utf8");
    expect(cli).toContain("256 * 1024");
    expect(cli).not.toContain("mkdtemp");
  });
  test("the page imports the selected relay statically", async () => {
    const page = await readFile(new URL("../web/tests/tls-relay-page.ts", import.meta.url), "utf8");
    expect(page).toContain('import { runtimeRelay } from "../src/net/relay.ts";');
    expect(page).not.toContain(UNRESOLVED_RELAY);
    expect(page).not.toMatch(/await import\(/);
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
  test("CLI takes exactly the controller's pinned handoff and stage output", () => {
    const handoff = "/work/tmp/q/handoff.json", output = "/work/tmp/q/tls/pg-early";
    const argv = ["--stage", "pg-early", "--browser", "chromium", "--engine", "browser", "--handoff", handoff, "--handoff-sha256", "a".repeat(64), "--output", output];
    const parsed = parseTlsArguments(argv);
    expect(parsed.evidence).toEqual({ handoff, handoffSha256: "a".repeat(64), output });
    expect(parsed.engine).toBe("browser");
    for (const name of ["--handoff", "--handoff-sha256", "--output"]) {
      const index = argv.indexOf(name);
      expect(() => parseTlsArguments(argv.slice(0, index).concat(argv.slice(index + 2)))).toThrow(name);
    }
    expect(() => parseTlsArguments(argv.map(value => value === handoff ? "q/handoff.json" : value))).toThrow("canonical absolute");
    expect(() => parseTlsArguments(argv.map(value => value === output ? "/work/tmp/q/../tls/pg-early" : value))).toThrow("canonical absolute");
    expect(() => parseTlsArguments(argv.map(value => value === "a".repeat(64) ? "A".repeat(64) : value))).toThrow("Invalid handoff SHA-256");
    for (const old of ["--intake-sha256", "--reviewed-head", "--reviewed-tree", "--database-machine", "--database-address", "--relay-address", "--page-port", "--relay-port", "--delivery", "--admission", "--source-release-sha256", "--host-source", "--pg-node-modules", "--pg-tarball"]) {
      expect(() => parseTlsArguments(argv.concat([old, "1"]))).toThrow("Unknown");
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


describe("Pi TLS PostgreSQL ownership", () => {
  const id = "0123456789abcdef01234567";
  const plan = () => piPostgresPlan("/home/pi", id, "100.94.222.118", "100.77.94.94/32");
  test("uses only the prepared official arm64 digest, Pi scratch and private publish", () => {
    const value = plan();
    expect(value.root).toBe(`/home/pi/tmp/bun-wasm-tls-${id}`);
    expect(value.image).toBe("docker.io/library/postgres@sha256:7a8050e52090c5f77effbe7e0cbed4a0587306776c3f26dc99933a63c619eaf1");
    expect(value.createArgs).toContain("--pull=never");
    expect(value.createArgs).toContain("100.94.222.118:45433:5432");
    expect(value.createArgs).toContain(`${value.volume}:/var/lib/postgresql/data`);
    for (const expected of ["--memory=768m", "--cpus=1.5", "--pids-limit=128", "--shm-size=128m", "POSTGRES_PASSWORD_FILE=/run/tls/password", "ssl=on", "password_encryption=scram-sha-256"]) expect(value.createArgs).toContain(expected);
    expect(value.hba).toContain("hostnossl all all 0.0.0.0/0 reject");
    expect(value.hba).toContain("hostssl all all 0.0.0.0/0 scram-sha-256");
    expect(value.createArgs.join(" ")).not.toMatch(/--privileged|--network=host|POSTGRES_PASSWORD=/);
  });
  test("rejects public addresses, path escapes and unowned names", () => {
    for (const args of [["/home/pi", "../escape", "100.94.222.118", "100.77.94.94/32"], ["/home/pi/../other", id, "100.94.222.118", "100.77.94.94/32"], ["/home/pi", id, "0.0.0.0", "100.77.94.94/32"], ["/home/pi", id, "100.94.222.118", "8.8.8.8/32"]]) {
      expect(() => piPostgresPlan(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3] ?? "")).toThrow();
    }
  });
  test("authenticates the prepared image without pulling or accepting empty inspect output", () => {
    const image = { Id: "sha256:c54a696c68013b2f8f42f479e00a2b6ad24c5ef10ee31cdfb8972cec3dad7eb7", Architecture: "arm64", Os: "linux", Digest: plan().image.split("@")[1] };
    expect(assertPiPostgresImage([image]).id).toBe(image.Id);
    for (const bad of [[], [{}], [{ ...image, Architecture: "amd64" }], [{ ...image, Digest: "sha256:" + "0".repeat(64) }], [{ ...image, Id: "sha256:" + "0".repeat(64) }]]) expect(() => assertPiPostgresImage(bad)).toThrow();
  });
  test("tears down only acquired names and confirms container absence before volume removal", async () => {
    const commands: string[][] = [];
    const run: PodmanRun = async args => { commands.push(Array.from(args)); return { code: args.includes("exists") ? 1 : 0, stdout: "" }; };
    await removePiPostgres(plan(), { container: true, volume: true }, run);
    expect(commands).toEqual([["rm", "--force", "--ignore", plan().name], ["container", "exists", plan().name], ["volume", "rm", "--ignore", plan().volume], ["volume", "exists", plan().volume]]);
    expect(commands.flat()).not.toContain("rmi");
    commands.length = 0;
    await removePiPostgres(plan(), { container: false, volume: false }, run);
    expect(commands).toEqual([]);
  });
  test("does not remove the volume after uncertain physical container stop", async () => {
    const commands: string[][] = [];
    const run: PodmanRun = async args => { commands.push(Array.from(args)); return { code: 0, stdout: "" }; };
    await expect(removePiPostgres(plan(), { container: true, volume: true }, run)).rejects.toThrow("container absence");
    expect(commands.some(args => args[0] === "volume")).toBe(false);
  });
  test("preflight and orchestration require Podman, not host PostgreSQL or Pi /work", async () => {
    const cli = await readFile(new URL("./tls-qualification.ts", import.meta.url), "utf8");
    expect(cli).toContain("podman info");
    expect(cli).not.toMatch(/command -v (initdb|postgres|pg_isready)|df -Pk \/work\/tmp/);
    const services = await readFile(new URL("../web/tests/tls-relay-services.ts", import.meta.url), "utf8");
    expect(services).toContain('piPostgresPlan(');
    expect(services).not.toContain('`/work/tmp/bun-wasm-tls-');
    const fixture = await readFile(new URL("../tests/servers/tls.ts", import.meta.url), "utf8");
    expect(fixture).not.toMatch(/execute\("(initdb|pg_isready)"|spawn\("postgres"|findmnt|pod\(\["pull"/);
    expect(fixture).toContain("await armStartupGuard(");
    expect(fixture).toContain('process.once("SIGTERM", stop)');
  });
});


describe("primary TLS host failure evidence", () => {
  const enoent = () => Object.assign(new Error("Executable not found in $PATH: \"mesh\""), { code: "ENOENT", syscall: "spawnSync mesh", path: "mesh", errno: -2 });
  test("the sealed lifecycle alone lets a cleanup error replace the setup error", async () => {
    const primary = enoent();
    const failure = await qualifiedRun(async () => undefined, async (_input, owner) => {
      owner.add(() => { throw new Error("cleanup witness failed"); });
      throw primary;
    }, async () => {}).catch(error => error);
    expect(failure).not.toBe(primary);
  });
  test("a setup error remains the primary cause when cleanup also fails", async () => {
    const primary = enoent();
    const cleanup = new Error("cleanup witness failed");
    const first = new FirstFailure();
    let exercised = false;
    const caught = await qualifiedRun(async () => undefined, first.guard(async (_input: undefined, owner: TlsCleanup) => {
      owner.add(() => { throw cleanup; });
      throw primary;
    }), first.guard(async () => { exercised = true; })).catch(error => error);
    const failure = first.resolve(caught) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(primary);
    expect(failure.errors[0]).toBe(primary);
    expect(failure.errors[1]).toBe(caught);
    expect(exercised).toBe(false);
    const diagnostic = JSON.parse(formatTlsFailure(new TlsQualificationFailure("pre-ledger-remote-inventory", failure)));
    expect(diagnostic.primary).toEqual({ name: "Error", message: primary.message, code: "ENOENT", errno: -2, syscall: "spawnSync mesh", path: "mesh" });
    expect(diagnostic.relatedErrors).toHaveLength(2);
    expect(diagnostic.relatedErrors.map((row: Record<string, unknown>) => row.message)).toEqual([undefined, undefined]);
  });
  test("an error with no later cleanup failure is reported unchanged", async () => {
    const primary = enoent();
    const first = new FirstFailure();
    const caught = await qualifiedRun(async () => undefined, first.guard(async () => { throw primary; }), async () => {}).catch(error => error);
    expect(first.resolve(caught)).toBe(primary);
  });
  test("post-setup messages, captured output, argv and environment never reach the diagnostic", async () => {
    const secret = "sentinel-password-0123456789";
    const child = Object.assign(new Error(`Command failed: mesh ssh pi -- psql ${secret}`), { code: "EPIPE", stdout: secret, stderr: secret, spawnargs: [secret], env: { PGPASSWORD: secret } });
    const text = formatTlsFailure(new TlsQualificationFailure("services", child));
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).primary).toEqual({ name: "Error", code: "EPIPE" });
    const messages: string[] = [];
    expect(await runTlsCli(async () => { throw new TlsQualificationFailure("browser", child); }, message => { messages.push(message); })).toBe(1);
    expect(messages.join("")).not.toContain(secret);
    expect(messages.at(-1)).toBe("TLS qualification failed. No application TLS acceptance is claimed.\n");
  });
  test("a successful run writes nothing and claims nothing", async () => {
    const messages: string[] = [];
    expect(await runTlsCli(async () => {}, message => { messages.push(message); })).toBe(0);
    expect(messages).toEqual([]);
  });
});
