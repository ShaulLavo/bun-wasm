import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { executableMemberPaths, tlsPagePaths, verifyPublicationBuilds } from "./producer-closure.ts";
import {
  SEALED_DIRECTORY_MODE, SEALED_EXECUTABLE_MODE, SEALED_FILE_MODE, sameTuple,
  type ConsumerHandoff, type FileIdentity, type InputManifest, type ReleaseTuple, type SourceIdentity, type TlsFixtureOptions, type TreeIdentity,
} from "./c1/contract.ts";
import { verifyTlsPage } from "./c1/tls-page.ts";
import { bindLoaded, parseLoaded, type LoadedObservation } from "./c1/loaded.ts";
import type { SealedDelivery } from "./c1/delivery.ts";
import { HOST_TOOL_NAMES, admitReplayHandoffFile, hostToolPath, type HarnessIdentity, type HostTools } from "./c1/replay.ts";
import { fileIdentity, inside, requireFile, requireTree, sameBytes, sha256, treeIdentity } from "./c1/identity.ts";
import { requireStagedDonor } from "./c1/inputs.ts";
import type { QualificationEngine } from "./tls-qualification-context.ts";

class MissingTlsInput extends Error { readonly code = "TLS_EXISTING_INPUT_CONTRACT_MISSING"; }
/** The single runtime/relay/programs/interface tuple TLS accepts. Every other tuple is rejected. */
export const tlsReleaseTuple: ReleaseTuple = { runtime: "0.0.110", relay: "0.0.109", programs: "programs-v0.0.15", programManifestSchema: "waffle-program-release/2", hostInterface: 1 };
const installedRuntimePackages = new Map<string, string>([["waffle", tlsReleaseTuple.runtime], ["waffle-relay", tlsReleaseTuple.relay]]);
export function requireInstalledRuntimePackage(name: string, metadata: Record<string, unknown>): void {
  const expected = installedRuntimePackages.get(name);
  if (!expected || metadata.version !== expected) throw new Error("Reviewed host requires exact installed runtime110/relay109");
}
/** The only stage this source unit runs; its output is that stage's directory beneath the handoff's TLS output. */
export const TLS_STAGE = "pg-early";
/**
 * What the caller pins: the exact handoff bytes, which bind the parent
 * intake hash and the selected source, and the output it assigns. Every
 * handoff claim is then re-derived from sealed bytes before use.
 */
export interface TlsEvidence {
  readonly handoff: string;
  readonly handoffSha256: string;
  readonly output: string;
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

/** The controller owns pinned, full replay handoff admission; TLS adds only its consumer policy. */
function admitHandoff(evidence: TlsEvidence) {
  const pinned = admitReplayHandoffFile(evidence.handoff, evidence.handoffSha256);
  const handoff = pinned.handoff.product;
  const { delivery } = pinned.product;
  if (!sameTuple(delivery.manifest.tuple, tlsReleaseTuple)) throw new Error("TLS requires the runtime110/relay109/programs15/schema2/interface1 tuple");
  return { handoff, delivery, inputs: delivery.inputs, harness: pinned.handoff.harness, hostTools: pinned.handoff.hostTools,
    records: [pinned.reference, pinned.handoff.replay, handoff.intake, delivery.identity, handoff.artifacts.config, handoff.artifacts.inputs] };
}
/** The config's bound fixture choices, propagated unchanged into the handoff. */
function fixtureOptions(handoff: ConsumerHandoff): TlsFixtureOptions {
  const tls = handoff.fixtures.tls;
  if (tls.status === "unresolved") throw new MissingTlsInput(`TLS fixture options unresolved: ${tls.missing}`);
  return tls.value;
}
/**
 * The sealed TLS page, built from this source before sealing. Its receipt,
 * outputs, bundled source inputs and resolved relay import are checked by the
 * controller's own verifier; the page is served only from these members.
 */
function sealedPage(delivery: SealedDelivery, sourceRoot: string): FileIdentity[] {
  verifyTlsPage(delivery.root, sourceRoot, delivery.manifest.source);
  return delivery.manifest.files.filter(file => file.path.startsWith(`${tlsPagePaths.root}/`))
    .map(file => ({ path: join(delivery.root, file.path), bytes: file.bytes, sha256: file.sha256 }));
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
/** GNU tar runs a gzip helper for .tgz reads; both are the replay's declared host tools, so `-z` never searches PATH. */
function pgTar(tools: HostTools, args: readonly string[]): Buffer {
  return execFileSync(hostToolPath(tools, "tar"), ["--use-compress-program", hostToolPath(tools, "gzip")].concat(args), { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
}
async function verifyPgArchive(tarball: FileIdentity, modules: string, tools: HostTools): Promise<void> {
  requireFile(tarball, "pg public tarball");
  const listing = pgTar(tools, ["-tvf", tarball.path]).toString("utf8");
  if (listing.split("\n").some(line => line && !line.startsWith("-") && !line.startsWith("d"))) throw new Error("pg tarball must contain ordinary files and directories");
  const names = pgTar(tools, ["-tf", tarball.path]).toString("utf8").trim().split("\n");
  const seen = new Set<string>();
  for (const name of names) {
    if (!name.startsWith("package/") || name.slice(8).split("/").some(part => part === ".." || part === ".") || seen.has(name)) throw new Error("Unsafe or duplicate pg tarball member");
    seen.add(name);
    if (name.endsWith("/")) continue;
    const expected = pgTar(tools, ["-xOf", tarball.path, "--", name]);
    const actual = fileIdentity(join(modules, "pg", name.slice(8)));
    if (!sameBytes(actual, { bytes: expected.length, sha256: sha256(expected) })) throw new Error(`Staged pg differs from the pinned public tarball: ${name}`);
  }
  const actual = (await walk(join(modules, "pg"))).map(name => `package/${name}`).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(names.filter(name => !name.endsWith("/")).toSorted())) throw new Error("Staged pg differs from the pinned public tarball");
}
/** Unmodified pg 8.16.3: pinned public tarball, complete transitive tree and its frozen project files. */
async function preflightPg(inputs: InputManifest, tools: HostTools) {
  const requirement = inputs.consumers.tls;
  if (requirement.status === "unresolved") throw new MissingTlsInput(`TLS dependencies unresolved: ${requirement.missing}`);
  const { pgTarball, pgModules, pgPackageJson, pgLock } = requirement.value;
  const project = dirname(pgModules.path);
  if (basename(pgModules.path) !== "node_modules" || pgPackageJson.path !== join(project, "package.json") || pgLock.path !== join(project, "bun.lock")) throw new Error("TLS pg project files must sit beside its node_modules");
  requirePresent([pgTarball.path, pgPackageJson.path, pgLock.path], "pg tarball and frozen project files");
  requireFile(pgTarball, "pg public tarball");
  const locks = [requireFile(pgPackageJson, "pg package.json"), requireFile(pgLock, "pg bun.lock")];
  const pg = await verifyDependencyTree(pgModules, "pg");
  await verifyPgArchive(pgTarball, pgModules.path, tools);
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
 * The replay's merged harness checkout is the host, a separate identity from
 * the product source. Its installed root and web trees must be the
 * authenticated donors, installed from its own frozen package files (which
 * the harness guard keeps identical to the product source's).
 */
function preflightHost(harness: HarnessIdentity, inputs: InputManifest) {
  const root = harness.sourceRoot;
  requireReviewedHostSource(root, harness.source);
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

/** One real response as the page received it: its request method, status, Content-Encoding and decoded body. */
export interface ObservedResponse {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly contentEncoding: string | undefined;
  readonly body: Uint8Array;
}
/**
 * The result's `loaded` rows: every successful GET the page or its workers
 * received, typed and bound by the controller's own parser and validator
 * before any result is written. Other GET responses loaded nothing; they are
 * kept for the record. POST control requests are not loaded objects.
 */
export function tlsLoaded(handoff: ConsumerHandoff, responses: readonly ObservedResponse[]) {
  const gets = responses.filter(response => response.method === "GET");
  const rows: unknown[] = gets.filter(response => response.status === 200).map(response => ({ url: response.url, method: response.method, status: response.status,
    encoding: response.contentEncoding ?? "identity", bytes: response.body.byteLength, sha256: sha256(response.body) }));
  const loaded: LoadedObservation[] = parseLoaded(rows);
  bindLoaded(handoff, "tls", loaded);
  return { loaded, unloaded: gets.filter(response => response.status !== 200).map(response => ({ url: response.url, status: response.status })) };
}

export async function preflightTls(evidence: TlsEvidence) {
  const { handoff, delivery, inputs, harness, hostTools, records } = admitHandoff(evidence);
  for (const name of HOST_TOOL_NAMES) hostToolPath(hostTools, name);
  if (evidence.output !== join(handoff.outputs.tls, TLS_STAGE)) throw new Error(`TLS output must be the handoff's ${TLS_STAGE} directory beneath outputs.tls`);
  const fixtures = fixtureOptions(handoff);
  const custody = custodyReferences(delivery);
  requireRetainedArchives(handoff, inputs);
  verifyPublicationBuilds(JSON.parse(readFileSync(handoff.artifacts.engineBuilds.path, "utf8")));
  requirePresent([handoff.dependencies.browsers.path], "Playwright browsers");
  requireTree(handoff.dependencies.browsers, "Playwright browsers");
  const pg = await preflightPg(inputs, hostTools);
  const host = preflightHost(harness, inputs);
  const page = sealedPage(delivery, host.root);
  const references = records.concat([handoff.artifacts.sourceArchive, handoff.artifacts.tlsPageReceipt, handoff.artifacts.tlsPgClient], custody);
  for (const reference of references) requireFile(reference, "TLS preflight reference");
  return {
    handoff, harness, hostTools, fixtures, page, hostSource: host.root, output: evidence.output, source: handoff.source, tuple: handoff.tuple,
    dependencies: { pg: pg.pg, host: host.host, locks: pg.locks.concat(host.locks) }, pgArchive: pg.pgArchive, references,
  };
}
export type TlsIntake = Awaited<ReturnType<typeof preflightTls>>;

async function requireSealedPath(root: string, path: string, mode: number): Promise<void> {
  const member = relative(root, path);
  if (!inside(root, path) || !member) throw new Error("Delivered file is outside its sealed root");
  const expected = executableMemberPaths().includes(member) ? SEALED_EXECUTABLE_MODE : SEALED_FILE_MODE;
  if ((mode & 0o7777) !== Number.parseInt(expected, 8)) throw new Error("TLS sealed file mode changed immediately before use");
  let directory = dirname(path);
  for (;;) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o7777) !== SEALED_DIRECTORY_MODE) throw new Error("TLS sealed directory mode changed immediately before use");
    if (directory === root) return;
    directory = dirname(directory);
  }
}
/** Sealed delivery reads also check registry modes and ancestors before and after the byte read. */
export async function readVerifiedFile(row: FileIdentity, sealedRoot?: string): Promise<Uint8Array<ArrayBuffer>> {
  const before = await lstat(row.path);
  if (!before.isFile()) throw new Error("Dependency must remain an ordinary file");
  if (sealedRoot !== undefined) await requireSealedPath(sealedRoot, row.path, before.mode);
  const bytes = await readFile(row.path);
  if (bytes.length !== row.bytes || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("Dependency byte/custody mismatch immediately before use");
  if (sealedRoot !== undefined) {
    const after = await lstat(row.path);
    if (!after.isFile()) throw new Error("Delivered file must remain an ordinary file");
    await requireSealedPath(sealedRoot, row.path, after.mode);
  }
  return bytes;
}
export async function recheckDependencies(intake: TlsIntake): Promise<void> {
  requireTree(intake.handoff.dependencies.browsers, "Playwright browsers");
  requireTree(intake.dependencies.pg.identity, "preflighted pg dependency");
  for (const tree of intake.dependencies.host) requireTree(tree, "preflighted host dependency");
  for (const lock of intake.dependencies.locks.concat([intake.pgArchive])) requireFile(lock, "preflighted frozen input");
  for (const name of HOST_TOOL_NAMES) hostToolPath(intake.hostTools, name);
}
