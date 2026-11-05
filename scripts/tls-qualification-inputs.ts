import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { verifyPublicationBuilds } from "./producer-closure.ts";
import {
  DELIVERY_RECORDS, parseConfig, parseHandoff, parseInputManifest, sameSource, sameTuple,
  type C1Config, type ConsumerHandoff, type FileIdentity, type InputManifest, type ReleaseTuple, type SourceIdentity, type TreeIdentity,
} from "./c1/contract.ts";
import { admitIntake, buildHandoff, readSealedDelivery, requireHandoffArtifacts, type SealedDelivery } from "./c1/delivery.ts";
import { fileIdentity, requireFile, requireTree, sameBytes, sha256, treeIdentity } from "./c1/identity.ts";
import { requireStagedDonor } from "./c1/inputs.ts";
import type { QualificationEngine } from "./tls-qualification-context.ts";

export class MissingTlsInput extends Error { readonly code = "TLS_EXISTING_INPUT_CONTRACT_MISSING"; }
/** The single runtime/relay/programs/interface tuple TLS accepts. Every other tuple is rejected. */
export const tlsReleaseTuple: ReleaseTuple = { runtime: "0.0.110", relay: "0.0.109", programs: "programs-v0.0.15", programManifestSchema: "waffle-program-release/2", hostInterface: 1 };
const installedRuntimePackages = new Map<string, string>([["waffle", tlsReleaseTuple.runtime], ["waffle-relay", tlsReleaseTuple.relay]]);
export function requireInstalledRuntimePackage(name: string, metadata: Record<string, unknown>): void {
  const expected = installedRuntimePackages.get(name);
  if (!expected || metadata.version !== expected) throw new Error("Reviewed host requires exact installed runtime110/relay109");
}
/**
 * Trust inputs supplied independently of every record: the controller's
 * handoff is only a locator; the intake bytes and reviewed source are pinned.
 */
export interface TlsEvidence {
  readonly handoff: string;
  readonly intakeSha256: string;
  readonly reviewedSource: SourceIdentity;
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}
export function digest(value: unknown, label: string, length = 64): string {
  const result = text(value, label);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result)) throw new Error(`Invalid ${label}`);
  return result;
}
/** An absent authenticated input is a missing contract input, reported before any setup. */
function requirePresent(paths: readonly string[], label: string): void {
  if (paths.some(path => !lstatSync(path, { throwIfNoEntry: false }))) throw new MissingTlsInput(`Missing authenticated ${label}`);
}

/** A sealed delivery record whose bytes are exactly the digest DELIVERY.json binds. */
function sealedRecord(delivery: SealedDelivery, path: string, expectedSha256: string, label: string): { readonly identity: FileIdentity; readonly value: unknown } {
  const bytes = readFileSync(join(delivery.root, path));
  if (sha256(bytes) !== expectedSha256) throw new Error(`TLS delivery ${label} record differs from DELIVERY.json`);
  return { identity: { path: join(delivery.root, path), bytes: bytes.length, sha256: expectedSha256 }, value: JSON.parse(bytes.toString("utf8")) };
}
/**
 * Re-derive the consumer handoff from the sealed delivery, its pinned intake
 * and the config and input manifest the delivery itself seals. The supplied
 * handoff must equal it exactly; none of its claims is trusted alone.
 */
function admitHandoff(evidence: TlsEvidence) {
  const claimed = parseHandoff(JSON.parse(readFileSync(evidence.handoff, "utf8")));
  const delivery = readSealedDelivery(claimed.delivery.root);
  const { source, tuple } = delivery.manifest;
  if (!sameSource(source, evidence.reviewedSource)) throw new Error("TLS reviewed source head/tree mismatch");
  if (!sameTuple(tuple, tlsReleaseTuple)) throw new Error("TLS requires the runtime110/relay109/programs15/schema2/interface1 tuple");
  const admitted = admitIntake(claimed.intake.path, evidence.intakeSha256, delivery);
  const configRecord = sealedRecord(delivery, DELIVERY_RECORDS.config, delivery.manifest.configSha256, "config");
  const inputsRecord = sealedRecord(delivery, DELIVERY_RECORDS.inputs, delivery.manifest.inputsSha256, "inputs");
  const config = parseConfig(configRecord.value);
  const inputs = parseInputManifest(inputsRecord.value);
  if (join(config.roots.run.artifact, "delivery") !== delivery.root) throw new Error("TLS delivery root differs from its sealed config");
  if (!sameBytes(config.manifest, inputsRecord.identity)) throw new Error("TLS sealed config names another input manifest");
  if (!sameSource(inputs.source, source) || !sameTuple(inputs.tuple, tuple)) throw new Error("TLS sealed inputs select another source or tuple");
  const handoff = buildHandoff(delivery, admitted.identity, inputs.consumers, config.roots.qualify.output, config.roots.qualify.browserTmp);
  if (!isDeepStrictEqual(handoff, claimed)) throw new Error("TLS handoff differs from the one its admitted delivery, config and inputs derive");
  requireHandoffArtifacts(handoff);
  return { handoff, delivery, config, inputs, records: [admitted.identity, delivery.identity, configRecord.identity, inputsRecord.identity] };
}

const custodyFamilies = ["", "native-custody-", "vendor-custody-"];
const custodyPhases = ["before", "after", "preseal"];
/** Before, after and preseal custody snapshots stay identical members of the sealed delivery. */
function custodyReferences(delivery: SealedDelivery): FileIdentity[] {
  const members = new Map(delivery.manifest.files.map(file => [file.path, file]));
  return custodyFamilies.flatMap(family => {
    const rows = custodyPhases.flatMap(phase => members.get(`inputs/${family}${phase}.json`) ?? []);
    const first = rows[0];
    if (!first || rows.length !== custodyPhases.length || rows.some(row => !sameBytes(row, first))) throw new Error("TLS before/after/preseal custody mismatch");
    return rows.map(row => ({ path: join(delivery.root, row.path), bytes: row.bytes, sha256: row.sha256 }));
  });
}
/** Delivered runtime and relay archives are exactly the authenticated inputs. */
function requireRetainedArchives(handoff: ConsumerHandoff, inputs: InputManifest): void {
  if (!sameBytes(handoff.artifacts.runtimeArchive, inputs.runtime.archive) || !sameBytes(handoff.artifacts.relayArchive, inputs.relay.archive)) throw new Error("TLS runtime or relay archive differs from its authenticated input");
}

async function walk(root: string, path = "", label = "TLS dependency"): Promise<string[]> {
  let results: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const name = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) results = results.concat(await walk(root, name, label));
    else if (entry.isFile()) results.push(name);
    else throw new Error(`${label} contains a symlink or special file`);
  }
  return results;
}
interface DependencyTree { readonly root: string; readonly identity: TreeIdentity; readonly files: readonly FileIdentity[] }
/** An ordinary-file tree whose complete identity is the authenticated one; its files are what may be seeded. */
async function verifyDependencyTree(expected: TreeIdentity, label: string): Promise<DependencyTree> {
  requirePresent([expected.path], `${label} dependency tree`);
  if (!(await lstat(expected.path)).isDirectory()) throw new Error(`${label} dependency root must be an ordinary directory, not a symlink`);
  const paths = (await walk(expected.path, "", `${label} dependency`)).toSorted();
  const files = paths.map(path => fileIdentity(join(expected.path, path)));
  requireTree(expected, `${label} dependency`);
  return { root: expected.path, identity: expected, files };
}
async function verifyPgArchive(tarball: FileIdentity, modules: string): Promise<void> {
  requireFile(tarball, "pg public tarball");
  const listing = execFileSync("tar", ["-tvzf", tarball.path], { encoding: "utf8", timeout: 15_000 });
  if (listing.split("\n").some(line => line && !line.startsWith("-") && !line.startsWith("d"))) throw new Error("pg tarball must contain ordinary files and directories");
  const names = execFileSync("tar", ["-tzf", tarball.path], { encoding: "utf8", timeout: 15_000 }).trim().split("\n");
  const seen = new Set<string>();
  for (const name of names) {
    if (!name.startsWith("package/") || name.slice(8).split("/").some(part => part === ".." || part === ".") || seen.has(name)) throw new Error("Unsafe or duplicate pg tarball member");
    seen.add(name);
    if (name.endsWith("/")) continue;
    const expected = execFileSync("tar", ["-xOzf", tarball.path, "--", name], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const actual = fileIdentity(join(modules, "pg", name.slice(8)));
    if (!sameBytes(actual, { bytes: expected.length, sha256: sha256(expected) })) throw new Error(`Staged pg differs from the pinned public tarball: ${name}`);
  }
  const actual = (await walk(join(modules, "pg"))).map(name => `package/${name}`).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(names.filter(name => !name.endsWith("/")).toSorted())) throw new Error("Staged pg differs from the pinned public tarball");
}
/** Unmodified pg 8.16.3: pinned public tarball, complete transitive tree and its frozen project files. */
async function preflightPg(inputs: InputManifest) {
  const requirement = inputs.consumers.tls;
  if (requirement.status === "unresolved") throw new MissingTlsInput(`TLS dependencies unresolved: ${requirement.missing}`);
  const { pgTarball, pgModules, pgPackageJson, pgLock } = requirement.value;
  const project = dirname(pgModules.path);
  if (basename(pgModules.path) !== "node_modules" || pgPackageJson.path !== join(project, "package.json") || pgLock.path !== join(project, "bun.lock")) throw new Error("TLS pg project files must sit beside its node_modules");
  requirePresent([pgTarball.path, pgPackageJson.path, pgLock.path], "pg tarball and frozen project files");
  requireFile(pgTarball, "pg public tarball");
  const locks = [requireFile(pgPackageJson, "pg package.json"), requireFile(pgLock, "pg bun.lock")];
  const pg = await verifyDependencyTree(pgModules, "pg");
  await verifyPgArchive(pgTarball, pgModules.path);
  const metadata = object(JSON.parse(readFileSync(join(pgModules.path, "pg/package.json"), "utf8")), "pg package");
  if (metadata.version !== "8.16.3") throw new Error("Unmodified pg 8.16.3 must be staged separately");
  return { pg, pgArchive: pgTarball, locks };
}

function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim(); }
function requireReviewedHostSource(root: string, expected: SourceIdentity): void {
  if (git(root, "rev-parse", "HEAD") !== expected.head || git(root, "rev-parse", "HEAD^{tree}") !== expected.tree) throw new Error("Host checkout differs from reviewed TLS source");
  if (git(root, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Host checkout must be clean reviewed source");
}
export async function verifyReviewedHostSource(root: string, expected: SourceIdentity): Promise<void> { requireReviewedHostSource(root, expected); }
const hostProjects = [["rootDependencies", ""], ["webDependencies", "web"]] as const;
const frozenProjectFiles = ["package.json", "bun.lock"];
/**
 * The sealed config's source checkout is the reviewed host. Its installed
 * root and web trees must be the authenticated donors, installed from that
 * source's own frozen package files.
 */
function preflightHost(config: C1Config, inputs: InputManifest, reviewed: SourceIdentity) {
  const root = config.sourceRoot;
  requireReviewedHostSource(root, reviewed);
  for (const name of ["web/src/net/relay.ts", "web/src/runner.ts"].concat(hostProjects.flatMap(([, directory]) => frozenProjectFiles.map(file => join(directory, file))))) git(root, "ls-files", "--error-unmatch", name);
  const host = hostProjects.map(([name, directory]) => {
    const donor = inputs.donors[name];
    const staged = join(root, directory, "node_modules");
    requirePresent([donor.path, staged], `host ${name} dependency tree`);
    requireTree(donor, `host ${name} donor`);
    requireStagedDonor(name, donor, staged, root);
    return treeIdentity(staged);
  });
  const locks = hostProjects.flatMap(([name, directory]) => frozenProjectFiles.map(file => {
    const frozen = fileIdentity(join(root, directory, file));
    if (!sameBytes(fileIdentity(join(dirname(inputs.donors[name].path), file)), frozen)) throw new Error(`Host ${name} was not installed from the reviewed frozen ${file}`);
    return frozen;
  }));
  for (const name of installedRuntimePackages.keys()) requireInstalledRuntimePackage(name, object(JSON.parse(readFileSync(join(root, "web/node_modules", name, "package.json"), "utf8")), "installed runtime package"));
  return { root, host, locks };
}

/** Guest roles a TLS engine loads, from the controller's role registry. */
export function guestArtifacts(handoff: ConsumerHandoff, engine: QualificationEngine): readonly FileIdentity[] {
  if (engine === "browser") return [handoff.artifacts.browserGuest];
  if (engine === "quickjs") return [handoff.artifacts.quickjsGuest, handoff.artifacts.quickjsSide];
  return [handoff.artifacts.jscGuest, handoff.artifacts.jscSide];
}

export async function preflightTls(evidence: TlsEvidence) {
  const handoffFile = fileIdentity(evidence.handoff);
  const { handoff, delivery, config, inputs, records } = admitHandoff(evidence);
  const custody = custodyReferences(delivery);
  requireRetainedArchives(handoff, inputs);
  verifyPublicationBuilds(JSON.parse(readFileSync(handoff.artifacts.engineBuilds.path, "utf8")));
  requirePresent([handoff.dependencies.browsers.path], "Playwright browsers");
  requireTree(handoff.dependencies.browsers, "Playwright browsers");
  const pg = await preflightPg(inputs);
  const host = preflightHost(config, inputs, evidence.reviewedSource);
  const references = [handoffFile].concat(records, [handoff.artifacts.sourceArchive], custody);
  for (const reference of references) requireFile(reference, "TLS preflight reference");
  return {
    handoff, hostSource: host.root, output: handoff.outputs.tls, source: handoff.source, tuple: handoff.tuple,
    dependencies: { pg: pg.pg, host: host.host, locks: pg.locks.concat(host.locks) }, pgArchive: pg.pgArchive, references,
  };
}
export type TlsIntake = Awaited<ReturnType<typeof preflightTls>>;

export async function readVerifiedFile(row: FileIdentity): Promise<Uint8Array<ArrayBuffer>> {
  if (!(await lstat(row.path)).isFile()) throw new Error("Dependency must remain an ordinary file");
  const bytes = await readFile(row.path);
  if (bytes.length !== row.bytes || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("Dependency byte/custody mismatch immediately before use");
  return bytes;
}
export async function recheckDependencies(intake: TlsIntake): Promise<void> {
  requireTree(intake.dependencies.pg.identity, "preflighted pg dependency");
  for (const tree of intake.dependencies.host) requireTree(tree, "preflighted host dependency");
  for (const lock of intake.dependencies.locks.concat([intake.pgArchive])) requireFile(lock, "preflighted frozen input");
}
