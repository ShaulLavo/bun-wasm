import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { requireCompletePublicationFiles, verifyPublicationBuilds, verifyPublicationNativeBacking, type ProducerSource } from "./producer-closure.ts";

export const deliveryContract = "bun-wasm.complete-producer-delivery.v2";
export const parentOwner = "mcp:e5ea79c9-80ba-4f6e-b71a-4886c114af80";
export interface FileIdentity { readonly bytes: number; readonly sha256: string }
export interface NamedIdentity extends FileIdentity { readonly path: string }
export interface TlsEvidence {
  readonly delivery: string;
  readonly admission: string;
  readonly admissionSha256: string;
  readonly deliverySha256: string;
  readonly sourceReleaseSha256: string;
  readonly reviewedSource: ProducerSource;
  readonly hostSource: string;
  readonly pgModules: string;
  readonly pgArchive: string;
  readonly pgArchiveSha256: string;
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
export function identity(value: unknown, label: string): FileIdentity {
  const row = object(value, label);
  if (typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 1) throw new Error(`Invalid ${label} bytes`);
  return { bytes: row.bytes, sha256: digest(row.sha256, `${label} SHA-256`) };
}
export function namedIdentity(value: unknown, label: string): NamedIdentity {
  const row = object(value, label);
  return { path: text(row.path, `${label} path`), ...identity(row, label) };
}
export function source(value: unknown): ProducerSource {
  const row = object(value, "source");
  return { head: digest(row.head ?? row.commit, "source head", 40), tree: digest(row.tree, "source tree", 40) };
}
function sameSource(value: unknown, expected: ProducerSource): void {
  const actual = source(value);
  if (actual.head !== expected.head || actual.tree !== expected.tree) throw new Error("TLS reviewed source head/tree mismatch");
}
export async function fileIdentity(path: string): Promise<FileIdentity> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("TLS evidence must be a regular file, not a symlink");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest("hex") };
}
export async function requireIdentity(path: string, expected: FileIdentity): Promise<void> {
  const actual = await fileIdentity(path);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`TLS byte/custody mismatch for ${path}`);
}
async function pinnedJson(path: string, sha256: string): Promise<Record<string, unknown>> {
  digest(sha256, "pinned SHA-256");
  const bytes = await readFile(path);
  if (!(await lstat(path)).isFile() || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("TLS pinned evidence hash mismatch");
  return object(JSON.parse(bytes.toString("utf8")), "TLS evidence");
}
export function deliveryPath(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe delivery path");
  return join(root, path);
}
async function walk(root: string, path = ""): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const name = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) results.push(...await walk(root, name));
    else if (entry.isFile()) results.push(name);
    else throw new Error("TLS delivery contains a symlink or special file");
  }
  return results;
}
export async function verifyInventory(root: string, value: unknown): Promise<NamedIdentity[]> {
  if (!Array.isArray(value)) throw new Error("Missing complete TLS delivery inventory");
  const files = value.map(row => namedIdentity(row, "delivery file"));
  requireCompletePublicationFiles(files);
  const expected = files.map(row => row.path).concat(["DELIVERY.json"]).sort();
  const actual = (await walk(root)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("TLS delivery inventory has missing or extra files");
  for (const row of files) await requireIdentity(deliveryPath(root, row.path), row);
  return files;
}
async function reference(value: unknown): Promise<Record<string, unknown>> {
  const row = namedIdentity(value, "parent intake reference");
  if (!isAbsolute(row.path)) throw new Error("Parent intake reference must be absolute");
  await requireIdentity(row.path, row);
  return pinnedJson(row.path, row.sha256);
}
export function parseParentIntake(value: unknown, expected: ProducerSource, root: string) {
  const row = object(value, "independent parent intake");
  if (row.kind !== "independent-parent-byte-admission" || row.owner !== parentOwner
    || row.parentByteIntakePassed !== true || row.packetBytesAdmitted !== true) throw new Error("Independent parent byte admission required; CURRENT is not admission");
  sameSource(row.source, expected);
  if (row.deliveryRoot !== root) throw new Error("Parent intake delivery root mismatch");
  const tuple = object(row.tuple, "parent tuple");
  if (tuple.runtime !== "0.0.109" || tuple.relay !== "0.0.109" || tuple.hostInterface !== 1
    || JSON.stringify(tuple.engines) !== JSON.stringify(["quickjs", "jsc", "browser"])) throw new Error("TLS requires an explicit matching runtime/relay109 three-engine intake");
  const intake = object(row.byteIntake, "byte intake");
  if (intake.missingExtraSymlinkOrBadHashes !== 0 || intake.sourceArchiveMatchesExactGitArchive !== true
    || intake.normalBuildProgramCompanionLauncherAndClosureHelpersPassed !== true) throw new Error("Incomplete parent byte/custody checks");
  const gates = object(row.gates, "parent gates");
  const custody = object(gates.beforeAfterPresealCustody, "parent custody");
  for (const family of ["source-inputs", "native-custody-", "vendor-custody-"]) identity(custody[family], family);
  return row;
}
export async function preflightTls(inputs: TlsEvidence) {
  for (const path of [inputs.delivery, inputs.admission, inputs.hostSource, inputs.pgModules, inputs.pgArchive]) if (!isAbsolute(path)) throw new Error("TLS inputs require explicit absolute paths");
  const root = resolve(inputs.delivery);
  if (!(await lstat(root)).isDirectory()) throw new Error("TLS delivery root must be a real directory");
  const parent = parseParentIntake(await pinnedJson(inputs.admission, inputs.admissionSha256), inputs.reviewedSource, root);
  const deliveryRef = namedIdentity(parent.deliveryManifest, "delivery manifest");
  if (deliveryRef.path !== join(root, "DELIVERY.json") || deliveryRef.sha256 !== inputs.deliverySha256) throw new Error("Parent delivery manifest identity mismatch");
  const manifest = await reference(deliveryRef);
  sameSource(manifest.source, inputs.reviewedSource);
  const files = await verifyInventory(root, manifest.files);
  const producerRef = namedIdentity(parent.producerAdmission, "producer admission");
  if (producerRef.path !== join(root, "inputs/ADMISSION.json")) throw new Error("Producer admission path mismatch");
  const producer = await reference(producerRef);
  sameSource(producer.source, inputs.reviewedSource);
  verifyPublicationBuilds(producer.builds);
  verifyPublicationNativeBacking(producer.nativeBacking);
  verifyPublicationNativeBacking(manifest.nativeBacking);
  const releaseRef = namedIdentity(parent.sourceRelease, "reviewed TLS source release");
  if (releaseRef.sha256 !== inputs.sourceReleaseSha256) throw new Error("Reviewed TLS source release identity mismatch");
  const release = await reference(releaseRef);
  sameSource(release.source, inputs.reviewedSource);
  if (release.kind !== "tested-producer-source-release") throw new Error("Tested source release required");
  const releasedTuple = object(release.tuple, "source release tuple");
  if (releasedTuple.runtime !== "0.0.109" || releasedTuple.relay !== "0.0.109" || releasedTuple.hostInterface !== 1) throw new Error("Reviewed TLS source release does not select runtime/relay109");
  const reuse = await reference(parent.canonicalReuse);
  await verifyReuse(root, reuse);
  const archive = namedIdentity(parent.sourceArchive, "source archive");
  if (archive.path !== join(root, "source.tar.gz")) throw new Error("Source archive path mismatch");
  await requireIdentity(archive.path, archive);
  await verifyCustody(root, files, object(object(parent.gates, "gates").beforeAfterPresealCustody, "custody"));
  verifyHostSource(inputs.hostSource, inputs.reviewedSource);
  for (const name of ["waffle", "waffle-relay"]) {
    const metadata = object(JSON.parse(await readFile(join(inputs.hostSource, "web/node_modules", name, "package.json"), "utf8")), "installed runtime package");
    if (metadata.version !== "0.0.109") throw new Error("Reviewed host requires exact installed runtime/relay109");
  }
  const pg = object(JSON.parse(await readFile(join(inputs.pgModules, "pg/package.json"), "utf8")), "pg package");
  if (pg.version !== "8.16.3") throw new Error("Unmodified pg 8.16.3 must be staged separately");
  await verifyPgArchive(inputs);
  return { inputs, files, source: inputs.reviewedSource, contract: deliveryContract, tuple: object(parent.tuple, "tuple") };
}
export type TlsIntake = Awaited<ReturnType<typeof preflightTls>>;
async function verifyReuse(root: string, reuse: Record<string, unknown>): Promise<void> {
  if (!Array.isArray(reuse.staged)) throw new Error("Missing canonical original/reuse custody");
  for (const value of reuse.staged) {
    const row = object(value, "reuse entry");
    const expected = identity(row, "reuse entry");
    await requireIdentity(text(row.originalPath, "original reuse path"), expected);
    await requireIdentity(deliveryPath(root, text(row.path, "reuse delivery path")), expected);
  }
}
async function verifyCustody(root: string, files: readonly NamedIdentity[], parent: Record<string, unknown>): Promise<void> {
  for (const family of ["", "native-custody-", "vendor-custody-"]) {
    const rows = ["before", "after", "preseal"].map(phase => files.find(row => row.path === `inputs/${family}${phase}.json`));
    const first = rows[0];
    if (!first || rows.some(row => !row || row.sha256 !== first.sha256 || row.bytes !== first.bytes)) throw new Error("TLS before/after/preseal custody mismatch");
    const intake = identity(parent[family || "source-inputs"], "parent custody");
    if (intake.bytes !== first.bytes || intake.sha256 !== first.sha256) throw new Error("TLS parent byte/custody mismatch");
    await requireIdentity(join(root, first.path), first);
  }
}
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim(); }
function verifyHostSource(root: string, expected: ProducerSource): void {
  if (git(root, "rev-parse", "HEAD") !== expected.head || git(root, "rev-parse", "HEAD^{tree}") !== expected.tree) throw new Error("Host checkout differs from reviewed TLS source");
  if (git(root, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Host checkout must be clean reviewed source");
  for (const name of ["web/src/net/relay.ts", "web/src/runner.ts"]) {
    const path = resolve(root, name);
    if (relative(root, path).startsWith("..")) throw new Error("Invalid host source path");
    git(root, "ls-files", "--error-unmatch", name);
  }
}

async function verifyPgArchive(inputs: TlsEvidence): Promise<void> {
  const archive = await fileIdentity(inputs.pgArchive);
  if (archive.sha256 !== digest(inputs.pgArchiveSha256, "public pg tarball SHA-256")) throw new Error("pg public tarball hash mismatch");
  const listing = execFileSync("tar", ["-tvzf", inputs.pgArchive], { encoding: "utf8", timeout: 15_000 });
  if (listing.split("\n").some(line => line && !line.startsWith("-") && !line.startsWith("d"))) throw new Error("pg tarball must contain ordinary files and directories");
  const names = execFileSync("tar", ["-tzf", inputs.pgArchive], { encoding: "utf8", timeout: 15_000 }).trim().split("\n");
  const seen = new Set<string>();
  for (const name of names) {
    if (!name.startsWith("package/") || name.slice(8).split("/").some(part => part === ".." || part === ".") || seen.has(name)) throw new Error("Unsafe or duplicate pg tarball member");
    seen.add(name);
    if (name.endsWith("/")) continue;
    const expected = execFileSync("tar", ["-xOzf", inputs.pgArchive, "--", name], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    await requireIdentity(join(inputs.pgModules, "pg", name.slice(8)), { bytes: expected.length, sha256: createHash("sha256").update(expected).digest("hex") });
  }
  const actual = (await walk(join(inputs.pgModules, "pg"))).map(name => `package/${name}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names.filter(name => !name.endsWith("/")).sort())) throw new Error("Staged pg differs from the pinned public tarball");
}
