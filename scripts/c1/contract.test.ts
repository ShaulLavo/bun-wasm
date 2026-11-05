import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completePublicationArtifactPaths, executableMemberPaths, handoffMemberPaths, selectedReleaseArchives } from "../producer-closure.ts";
import waffleRelease from "../waffle-release-inputs.json";
import { EXECUTABLE_ROLES, HANDOFF_ROLES, ContractError, draftEntries, parseConfig, parseDelivery, parseHandoff, parseInputManifest, parseIntake } from "./contract.ts";
import { FIXTURE_LAUNCHER_OUTPUT, FIXTURE_SOURCE, FIXTURE_TUPLE, writeContractFixture, writeFixtureDelivery } from "./contract-fixture.ts";
import { admitIntake, buildHandoff, readSealedDelivery, requireHandoffArtifacts, sealDelivery, type SealedDelivery } from "./delivery.ts";
import { fileIdentity, sha256 } from "./identity.ts";

const scratch: string[] = [];
/** Test-owned cleanup: the fixture's own sealed directories are made writable only to delete them. */
function release(root: string): void {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root)) release(join(root, entry));
}
afterEach(() => {
  for (const root of scratch.splice(0)) { release(root); rmSync(root, { recursive: true, force: true }); }
});
function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-c1-contract-"));
  scratch.push(root);
  return join(root, "fixture");
}
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function sealedFixture(root: string): SealedDelivery {
  writeFixtureDelivery(root);
  sealDelivery(root, { source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, configSha256: sha256("c"), inputsSha256: sha256("i") });
  return readSealedDelivery(root);
}
function modeOf(path: string): number { return lstatSync(path).mode & 0o7777; }
/** Writable copy of a delivery member, replacing the sealed one through its (test-unsealed) directory. */
function tamper(root: string, member: string, change: (path: string) => void): void {
  const directory = join(root, member, "..");
  chmodSync(directory, 0o700);
  change(join(root, member));
  chmodSync(directory, 0o555);
}

test("the executable fixture writes every contract file and each parses strictly", () => {
  const fixture = writeContractFixture(fresh());
  const delivery = parseDelivery(json(join(fixture.delivery, "DELIVERY.json")));
  expect(delivery.files.length).toBe(completePublicationArtifactPaths().length);
  expect(parseIntake(json(fixture.intake)).members).toBe(delivery.files.length);
  const handoff = parseHandoff(json(fixture.handoff));
  expect(Object.keys(handoff.artifacts).sort()).toEqual(HANDOFF_ROLES.toSorted());
  expect(Object.keys(handoff.outputs).sort()).toEqual(["five-owner", "relay", "tls"]);
  requireHandoffArtifacts(handoff);
  const inputs = parseInputManifest(json(fixture.inputs));
  expect(draftEntries(inputs).map(entry => entry.split(":")[0])).toEqual(["native.jsc", "native.sdk", "native.sysroot", "native.shell", "relay", "consumers.tls", "consumers.relay"]);
});

test("the sealed launcher runs from its sealed path without any chmod", () => {
  const fixture = writeContractFixture(fresh());
  const handoff = parseHandoff(json(fixture.handoff));
  const launcher = handoff.artifacts.launcher.path;
  expect(EXECUTABLE_ROLES).toEqual(["launcher"]);
  expect(modeOf(launcher)).toBe(0o555);
  const before = statSync(launcher, { bigint: true });
  const run = spawnSync(launcher, [], { encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe(FIXTURE_LAUNCHER_OUTPUT);
  const after = statSync(launcher, { bigint: true });
  expect([after.mode, after.ctimeNs, after.ino]).toEqual([before.mode, before.ctimeNs, before.ino]);
});

test("ordinary payloads are sealed read-only and non-executable regardless of their input mode", () => {
  const root = join(fresh(), "delivery");
  writeFixtureDelivery(root);
  const guest = handoffMemberPaths().jscGuest;
  chmodSync(join(root, guest), 0o755);
  sealDelivery(root, { source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, configSha256: sha256("c"), inputsSha256: sha256("i") });
  const sealed = readSealedDelivery(root);
  for (const member of sealed.manifest.files) expect(modeOf(join(root, member.path))).toBe(executableMemberPaths().includes(member.path) ? 0o555 : 0o444);
  expect(modeOf(join(root, "DELIVERY.json"))).toBe(0o444);
  expect(() => accessSync(join(root, guest), constants.X_OK)).toThrow();
  expect(() => openSync(join(root, guest), "r+")).toThrow();
  expect(spawnSync(join(root, guest)).error).toBeDefined();
  expect(modeOf(join(root, "split/dist"))).toBe(0o555);
});

test("verification refuses a launcher sealed 0444 and never repairs it", () => {
  const root = join(fresh(), "delivery");
  const sealed = sealedFixture(root);
  const launcher = join(root, handoffMemberPaths().launcher);
  const handoff = buildHandoff(sealed, fileIdentity(join(root, "DELIVERY.json")), parseInputManifest(json(writeContractFixture(fresh()).inputs)).consumers,
    { tls: { status: "unresolved", missing: "not chosen" } }, join(root, "..", "q"), "/work/tmp/c1");
  chmodSync(launcher, 0o444);
  const before = statSync(launcher, { bigint: true });
  expect(() => readSealedDelivery(root)).toThrow("sealed mode of split/launcher/bun-wasm is 0444, expected 0555");
  expect(() => requireHandoffArtifacts(handoff)).toThrow("handoff launcher has mode 0444, expected sealed 0555");
  const after = statSync(launcher, { bigint: true });
  expect([after.mode, after.ctimeNs]).toEqual([before.mode, before.ctimeNs]);
  expect(spawnSync(launcher).error?.message).toContain("EACCES");
});

test("readers never change sealed metadata", () => {
  const fixture = writeContractFixture(fresh());
  const paths = Object.values(parseHandoff(json(fixture.handoff)).artifacts).map(artifact => artifact.path).concat([join(fixture.delivery, "DELIVERY.json"), fixture.delivery]);
  const before = paths.map(path => { const stat = statSync(path, { bigint: true }); return [stat.mode, stat.ctimeNs, stat.ino]; });
  const sealed = readSealedDelivery(fixture.delivery);
  admitIntake(fixture.intake, fileIdentity(fixture.intake).sha256, sealed);
  requireHandoffArtifacts(parseHandoff(json(fixture.handoff)));
  const after = paths.map(path => { const stat = statSync(path, { bigint: true }); return [stat.mode, stat.ctimeNs, stat.ino]; });
  expect(after).toEqual(before);
});

test.each([
  ["a changed byte", (path: string) => writeFileSync(path, "changed")],
  ["an executable bit on a payload", (path: string) => chmodSync(path, 0o555)],
  ["a removed member", (path: string) => rmSync(path)],
])("a sealed delivery with %s refuses", (_name, change) => {
  const root = join(fresh(), "delivery");
  sealedFixture(root);
  tamper(root, handoffMemberPaths().quickjsGuest, path => { chmodSync(path, 0o600); change(path); });
  expect(() => readSealedDelivery(root)).toThrow();
});

test("an extra file or symlink in a sealed delivery refuses", () => {
  const root = join(fresh(), "delivery");
  sealedFixture(root);
  tamper(root, "split/extra.wasm", path => writeFileSync(path, "extra"));
  expect(() => readSealedDelivery(root)).toThrow("missing or extra files");
  const other = join(fresh(), "delivery");
  sealedFixture(other);
  tamper(other, "split/alias", path => symlinkSync(join(other, "source.tar.gz"), path));
  expect(() => readSealedDelivery(other)).toThrow("symlink");
});

test("a manifest that claims a different mode than the registry refuses", () => {
  const root = join(fresh(), "delivery");
  sealedFixture(root);
  const manifest = json(join(root, "DELIVERY.json")) as { files: { path: string; mode: string }[] };
  const guest = manifest.files.find(file => file.path === handoffMemberPaths().jscGuest);
  if (!guest) throw new Error("fixture lacks the JSC guest");
  guest.mode = "0555";
  tamper(root, "DELIVERY.json", path => { chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(manifest)); chmodSync(path, 0o444); });
  expect(() => readSealedDelivery(root)).toThrow("differs from the registry");
});

test("DELIVERY.json is written exactly once", () => {
  const root = join(fresh(), "delivery");
  writeFixtureDelivery(root);
  const facts = { source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, configSha256: sha256("c"), inputsSha256: sha256("i") };
  sealDelivery(root, facts);
  expect(() => sealDelivery(root, facts)).toThrow();
});

test("consumers start only from an intake of this exact delivery", () => {
  const fixture = writeContractFixture(fresh());
  const sealed = readSealedDelivery(fixture.delivery);
  const intake = json(fixture.intake) as Record<string, unknown>;
  const variant = (name: string, change: Record<string, unknown>) => {
    const path = join(fixture.intake, "..", `${name}.json`);
    writeFileSync(path, JSON.stringify({ ...intake, ...change }));
    return () => admitIntake(path, fileIdentity(path).sha256, sealed);
  };
  expect(() => admitIntake(fixture.intake, sha256("other"), sealed)).toThrow("pinned SHA-256");
  expect(variant("unit6", { source: { head: "ffbccf9a4bdf9628a75d751b0160ce79ba842ce0", tree: "27e95136c2e3ee91897c206b96184c2cef5fa55b" } })).toThrow("source or tuple");
  expect(variant("runtime109", { tuple: { ...FIXTURE_TUPLE, runtime: "0.0.109" } })).toThrow("source or tuple");
  expect(variant("root", { deliveryRoot: "/work/artifacts/other/delivery" })).toThrow("different delivery");
  expect(variant("bytes", { delivery: { ...sealed.identity, sha256: sha256("other") } })).toThrow("different DELIVERY.json");
  expect(variant("members", { members: 1 })).toThrow("member count");
  expect(variant("producer", { admitted: false })).toThrow(ContractError);
});

test("parsers reject unknown fields, unauthenticated verified labels and undefined relay requirements", () => {
  const fixture = writeContractFixture(fresh());
  const inputs = json(fixture.inputs) as Record<string, Record<string, unknown>>;
  expect(() => parseInputManifest({ ...inputs, extra: true })).toThrow("unknown field extra");
  expect(() => parseInputManifest({ ...inputs, relay: { ...inputs.relay, provenance: { status: "verified", receipts: [] } } })).toThrow("at least one original receipt");
  expect(() => parseInputManifest({ ...inputs, consumers: { ...inputs.consumers, relay: { status: "resolved", value: {} } } })).toThrow("no defined resolved shape");
  const { bun: _bun, ...partial } = inputs.donors ?? {};
  expect(() => parseInputManifest({ ...inputs, donors: partial })).toThrow("missing bun");
  expect(() => parseInputManifest({ ...inputs, tools: { ...inputs.tools, rustfmt: inputs.tools?.cargo } })).toThrow("unknown field rustfmt");
  expect(() => parseConfig({ schema: "bun-wasm.c1-config/1", sourceRoot: "/a/../b", manifest: {}, roots: {}, jobs: 2, fixtures: {} })).toThrow("canonical absolute path");
});

test("the delivery keeps the runtime and relay archives this source pins, not a historical name", () => {
  const archives = selectedReleaseArchives();
  expect(archives.runtime).toEqual({ version: waffleRelease.version, url: waffleRelease.url, path: `runtime/waffle-${waffleRelease.version}.tgz` });
  expect(archives.relay.path).toBe(`relay/waffle-relay-${archives.relay.version}.tgz`);
  const registry = completePublicationArtifactPaths();
  expect(registry).toContain(archives.runtime.path);
  expect(registry).toContain(archives.relay.path);
  expect(registry.some(path => path.includes("runtime107"))).toBe(false);
  expect(new Set(registry).size).toBe(registry.length);
});
