import { isAbsolute, resolve } from "node:path";

/**
 * The C1 controller's external contract: its one config, its one input
 * manifest, the sealed delivery it writes, the independent intake record that
 * gates consumers, and the read-only handoff each consumer receives. Every
 * parser accepts exactly one shape and rejects unknown fields. Parsing never
 * authenticates anything: a "verified" label or a receipt list is a claim that
 * admission must check against actual bytes.
 */

export interface SourceIdentity { readonly head: string; readonly tree: string }
/** An absolute file with its exact size and SHA-256. */
export interface FileIdentity { readonly path: string; readonly bytes: number; readonly sha256: string }
/** An absolute directory and the identity of its complete entry listing. */
export interface TreeIdentity extends FileIdentity { readonly files: number }
/**
 * Sealed modes. The registry names which members are executable; nothing
 * trusts an input's mode bits or a file name. Consumers never chmod a sealed
 * file: an executable member runs from its sealed path.
 */
export const SEALED_FILE_MODE = "0444";
export const SEALED_EXECUTABLE_MODE = "0555";
export const SEALED_DIRECTORY_MODE = 0o555;
export type SealedMode = typeof SEALED_FILE_MODE | typeof SEALED_EXECUTABLE_MODE;
/** A delivery member, relative to the delivery root, with its sealed mode. */
export interface MemberIdentity { readonly path: string; readonly bytes: number; readonly sha256: string; readonly mode: SealedMode }

export interface ReleaseTuple {
  readonly runtime: string;
  readonly relay: string;
  readonly programs: string;
  readonly programManifestSchema: string;
  readonly hostInterface: number;
}

/** Caller-stated origin. Draft entries are known gaps and refuse production. */
export type Provenance =
  | { readonly status: "verified"; readonly receipts: readonly FileIdentity[] }
  | { readonly status: "draft"; readonly missing: string };

/** A consumer requirement that is either fully stated or explicitly open. */
export type Requirement<T> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "unresolved"; readonly missing: string };

export const DONOR_NAMES = ["bun", "boringssl", "rootDependencies", "webDependencies", "sandboxDependencies", "cargo", "rustup", "tools", "bunCache"] as const;
export type DonorName = typeof DONOR_NAMES[number];
export const TOOL_NAMES = ["bun", "node", "git", "bash", "cargo", "rustc", "rust-lld", "wasm-tools", "wasm-opt", "wasmtime", "cmake", "ninja", "clang", "clang++", "llvm-ar", "wasm-ld", "cc", "c++"] as const;
export type ToolName = typeof TOOL_NAMES[number];
export const CONSUMERS = ["five-owner", "tls", "relay"] as const;
export type ConsumerName = typeof CONSUMERS[number];

export interface NativeRoot { readonly root: string; readonly files: readonly FileIdentity[]; readonly provenance: Provenance }
export interface TlsDependencies {
  /** Unmodified public pg tarball, pinned by its own SHA-256. */
  readonly pgTarball: FileIdentity;
  /** The complete installed pg tree with every transitive package. */
  readonly pgModules: TreeIdentity;
  readonly pgPackageJson: FileIdentity;
  readonly pgLock: FileIdentity;
}
export interface ConsumerDependencies {
  /** Installed Playwright browsers the Chromium consumers launch. */
  readonly browsers: TreeIdentity;
  readonly tls: Requirement<TlsDependencies>;
  /** Relay's remaining needs are not defined yet; only "unresolved" parses. */
  readonly relay: Requirement<never>;
}

export interface InputManifest {
  readonly schema: "bun-wasm.c1-inputs/1";
  readonly source: SourceIdentity;
  readonly tuple: ReleaseTuple;
  readonly runtime: { readonly archive: FileIdentity; readonly authentication: FileIdentity };
  readonly relay: { readonly archive: FileIdentity; readonly provenance: Provenance };
  readonly programs: { readonly manifest: FileIdentity; readonly checksums: FileIdentity; readonly archives: readonly FileIdentity[] };
  readonly fd3: { readonly artifact: FileIdentity; readonly receipt: FileIdentity };
  readonly native: { readonly jsc: NativeRoot; readonly sdk: NativeRoot; readonly sysroot: NativeRoot; readonly shell: NativeRoot };
  readonly donors: Readonly<Record<DonorName, TreeIdentity>>;
  readonly tools: Readonly<Record<ToolName, FileIdentity>>;
  readonly consumers: ConsumerDependencies;
}

export interface RunRoots { readonly report: string; readonly artifact: string; readonly private: string; readonly browserTmp: string }
export interface RehearseRoots { readonly report: string; readonly private: string; readonly browserTmp: string }
export interface QualifyRoots { readonly output: string; readonly private: string; readonly browserTmp: string }
export interface C1Config {
  readonly schema: "bun-wasm.c1-config/1";
  readonly sourceRoot: string;
  readonly manifest: FileIdentity;
  readonly roots: { readonly run: RunRoots; readonly qualify: QualifyRoots; readonly rehearse?: RehearseRoots };
  readonly jobs: number;
}

export const DELIVERY_STATUS = "producer-complete; awaiting-independent-parent-byte-intake";
/** Delivery members the controller writes for every consumer to bind. */
export const DELIVERY_RECORDS = { config: "inputs/CONFIG.json", inputs: "inputs/INPUTS.json", environment: "inputs/ENVIRONMENT.json", stages: "proof/stages.json" } as const;
/** `DELIVERY.json`, written once after every gate. Its inventory excludes itself. */
export interface DeliveryManifest {
  readonly schema: "bun-wasm.c1-delivery/1";
  readonly status: typeof DELIVERY_STATUS;
  readonly source: SourceIdentity;
  readonly tuple: ReleaseTuple;
  readonly configSha256: string;
  readonly inputsSha256: string;
  readonly files: readonly MemberIdentity[];
  readonly parentByteIntake: null;
  readonly consumerAcceptance: null;
  readonly deployment: null;
}

/** Written by the independent parent after it checked every delivery byte. */
export interface ParentIntake {
  readonly schema: "bun-wasm.c1-intake/1";
  readonly kind: "independent-parent-byte-admission";
  readonly owner: string;
  readonly at: string;
  readonly deliveryRoot: string;
  readonly delivery: FileIdentity;
  readonly source: SourceIdentity;
  readonly tuple: ReleaseTuple;
  /** Number of manifest members the parent re-hashed, equal to `files.length`. */
  readonly members: number;
  readonly admitted: true;
}

export const HANDOFF_ROLES = [
  "quickjsGuest", "quickjsGuestReceipt", "quickjsSide", "quickjsSideReceipt",
  "jscGuest", "jscGuestReceipt", "jscSide", "jscSideReceipt", "jscEmbeddingReceipt",
  "launcher", "launcherReceipt", "shell", "envUtility", "shellReceipt",
  "browserGuest", "browserGuestReceipt", "sourceCacheBrowserGuest", "sourceCacheBrowserGuestReceipt",
  "toolsGuest", "toolsGuestReceipt", "webIndex", "engineBuilds", "producerManifest",
  "sourceArchive", "runtimeArchive", "relayArchive", "programManifest", "programChecksums",
  "fd3Artifact", "fd3Receipt", "config", "inputs", "environment", "stages",
] as const;
export type HandoffRole = typeof HANDOFF_ROLES[number];
/** Handoff roles sealed 0555 and executed from their sealed path. Every other role is 0444. */
export const EXECUTABLE_ROLES: readonly HandoffRole[] = ["launcher"];
/** Read-only paths every consumer receives after a matching intake. */
export interface ConsumerHandoff {
  readonly schema: "bun-wasm.c1-handoff/1";
  readonly source: SourceIdentity;
  readonly tuple: ReleaseTuple;
  readonly delivery: { readonly root: string; readonly manifest: FileIdentity };
  readonly intake: FileIdentity;
  readonly artifacts: Readonly<Record<HandoffRole, FileIdentity>>;
  /** Delivered web root; every file under it is a delivery member. */
  readonly webRoot: string;
  readonly dependencies: ConsumerDependencies;
  /** Each consumer's own writable output directory, beneath the claimed qualification root. */
  readonly outputs: Readonly<Record<ConsumerName, string>>;
  /** Physical browser scratch root; derived TMPDIRs stay within 48 bytes. */
  readonly browserTmp: string;
}

export class ContractError extends Error {}
function fail(label: string, problem: string): never { throw new ContractError(`${label}: ${problem}`); }

type Row = Record<string, unknown>;
function row(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "expected an object");
  const fields = value as Row;
  for (const key of Object.keys(fields)) if (!required.includes(key) && !optional.includes(key)) fail(label, `unknown field ${key}`);
  for (const key of required) if (!(key in fields)) fail(label, `missing ${key}`);
  return fields;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") fail(label, "expected non-empty text");
  return value;
}
function literal<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) fail(label, `expected ${expected}`);
  return expected;
}
function hex(value: unknown, length: number, label: string): string {
  const result = text(value, label);
  if (result.length !== length || !/^[a-f0-9]+$/.test(result)) fail(label, `expected ${length} lowercase hex digits`);
  return result;
}
export function sha256Text(value: unknown, label: string): string { return hex(value, 64, label); }
function count(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(label, `expected an integer of at least ${minimum}`);
  return value;
}
/** Canonical absolute path: no `.`/`..` segments, no trailing slash. */
export function absolutePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") fail(label, "expected a canonical absolute path");
  return path;
}
/** Relative member path without traversal, absolute or empty segments. */
export function memberPath(value: unknown, label: string): string {
  const path = text(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => part === "" || part === "." || part === "..")) fail(label, "expected a safe relative path");
  return path;
}
function list<T>(value: unknown, label: string, item: (value: unknown, label: string) => T): T[] {
  if (!Array.isArray(value)) fail(label, "expected an array");
  return value.map((entry, index) => item(entry, `${label}[${index}]`));
}

export function parseSource(value: unknown, label = "source"): SourceIdentity {
  const fields = row(value, label, ["head", "tree"]);
  return { head: hex(fields.head, 40, `${label}.head`), tree: hex(fields.tree, 40, `${label}.tree`) };
}
export function parseFile(value: unknown, label: string): FileIdentity {
  const fields = row(value, label, ["path", "bytes", "sha256"]);
  return { path: absolutePath(fields.path, `${label}.path`), bytes: count(fields.bytes, `${label}.bytes`, 0), sha256: sha256Text(fields.sha256, `${label}.sha256`) };
}
export function parseTree(value: unknown, label: string): TreeIdentity {
  const fields = row(value, label, ["path", "bytes", "sha256", "files"]);
  return { path: absolutePath(fields.path, `${label}.path`), bytes: count(fields.bytes, `${label}.bytes`, 0), sha256: sha256Text(fields.sha256, `${label}.sha256`), files: count(fields.files, `${label}.files`, 1) };
}
export function parseMember(value: unknown, label: string): MemberIdentity {
  const fields = row(value, label, ["path", "bytes", "sha256", "mode"]);
  if (fields.mode !== SEALED_FILE_MODE && fields.mode !== SEALED_EXECUTABLE_MODE) fail(`${label}.mode`, `expected ${SEALED_FILE_MODE} or ${SEALED_EXECUTABLE_MODE}`);
  return { path: memberPath(fields.path, `${label}.path`), bytes: count(fields.bytes, `${label}.bytes`, 0), sha256: sha256Text(fields.sha256, `${label}.sha256`), mode: fields.mode };
}
export function parseTuple(value: unknown, label = "tuple"): ReleaseTuple {
  const fields = row(value, label, ["runtime", "relay", "programs", "programManifestSchema", "hostInterface"]);
  return { runtime: text(fields.runtime, `${label}.runtime`), relay: text(fields.relay, `${label}.relay`), programs: text(fields.programs, `${label}.programs`),
    programManifestSchema: text(fields.programManifestSchema, `${label}.programManifestSchema`), hostInterface: count(fields.hostInterface, `${label}.hostInterface`, 1) };
}
export function sameSource(a: SourceIdentity, b: SourceIdentity): boolean { return a.head === b.head && a.tree === b.tree; }
export function sameTuple(a: ReleaseTuple, b: ReleaseTuple): boolean {
  return a.runtime === b.runtime && a.relay === b.relay && a.programs === b.programs && a.programManifestSchema === b.programManifestSchema && a.hostInterface === b.hostInterface;
}

function parseProvenance(value: unknown, label: string): Provenance {
  const kind = row(value, label, ["status"], ["receipts", "missing"]).status;
  if (kind === "draft") return { status: "draft", missing: text(row(value, label, ["status", "missing"]).missing, `${label}.missing`) };
  if (kind !== "verified") fail(`${label}.status`, "expected verified or draft");
  const receipts = list(row(value, label, ["status", "receipts"]).receipts, `${label}.receipts`, parseFile);
  if (receipts.length === 0) fail(`${label}.receipts`, "a verified claim names at least one original receipt");
  return { status: "verified", receipts };
}
function parseNative(value: unknown, label: string): NativeRoot {
  const fields = row(value, label, ["root", "files", "provenance"]);
  return { root: absolutePath(fields.root, `${label}.root`), files: list(fields.files, `${label}.files`, parseFile), provenance: parseProvenance(fields.provenance, `${label}.provenance`) };
}
/** Exactly the named keys, each parsed; a partial or extended record fails. */
function exactRecord<K extends string, T>(value: unknown, names: readonly K[], label: string, item: (value: unknown, label: string) => T): Record<K, T> {
  const fields = row(value, label, names);
  return Object.fromEntries(names.map(name => [name, item(fields[name], `${label}.${name}`)])) as Record<K, T>;
}
function parseRequirement<T>(value: unknown, label: string, resolved: ((value: unknown, label: string) => T) | undefined): Requirement<T> {
  const kind = row(value, label, ["status"], ["value", "missing"]).status;
  if (kind === "unresolved") return { status: "unresolved", missing: text(row(value, label, ["status", "missing"]).missing, `${label}.missing`) };
  if (kind !== "resolved") fail(`${label}.status`, "expected resolved or unresolved");
  if (!resolved) fail(label, "this requirement has no defined resolved shape yet");
  return { status: "resolved", value: resolved(row(value, label, ["status", "value"]).value, `${label}.value`) };
}
function parseTls(value: unknown, label: string): TlsDependencies {
  const fields = row(value, label, ["pgTarball", "pgModules", "pgPackageJson", "pgLock"]);
  return { pgTarball: parseFile(fields.pgTarball, `${label}.pgTarball`), pgModules: parseTree(fields.pgModules, `${label}.pgModules`),
    pgPackageJson: parseFile(fields.pgPackageJson, `${label}.pgPackageJson`), pgLock: parseFile(fields.pgLock, `${label}.pgLock`) };
}
export function parseConsumerDependencies(value: unknown, label = "consumers"): ConsumerDependencies {
  const fields = row(value, label, ["browsers", "tls", "relay"]);
  return { browsers: parseTree(fields.browsers, `${label}.browsers`), tls: parseRequirement(fields.tls, `${label}.tls`, parseTls),
    relay: parseRequirement<never>(fields.relay, `${label}.relay`, undefined) };
}

export function parseInputManifest(value: unknown): InputManifest {
  const fields = row(value, "inputs", ["schema", "source", "tuple", "runtime", "relay", "programs", "fd3", "native", "donors", "tools", "consumers"]);
  const runtime = row(fields.runtime, "inputs.runtime", ["archive", "authentication"]);
  const relay = row(fields.relay, "inputs.relay", ["archive", "provenance"]);
  const programs = row(fields.programs, "inputs.programs", ["manifest", "checksums", "archives"]);
  const fd3 = row(fields.fd3, "inputs.fd3", ["artifact", "receipt"]);
  return {
    schema: literal(fields.schema, "bun-wasm.c1-inputs/1", "inputs.schema"),
    source: parseSource(fields.source, "inputs.source"),
    tuple: parseTuple(fields.tuple, "inputs.tuple"),
    runtime: { archive: parseFile(runtime.archive, "inputs.runtime.archive"), authentication: parseFile(runtime.authentication, "inputs.runtime.authentication") },
    relay: { archive: parseFile(relay.archive, "inputs.relay.archive"), provenance: parseProvenance(relay.provenance, "inputs.relay.provenance") },
    programs: { manifest: parseFile(programs.manifest, "inputs.programs.manifest"), checksums: parseFile(programs.checksums, "inputs.programs.checksums"),
      archives: list(programs.archives, "inputs.programs.archives", parseFile) },
    fd3: { artifact: parseFile(fd3.artifact, "inputs.fd3.artifact"), receipt: parseFile(fd3.receipt, "inputs.fd3.receipt") },
    native: exactRecord(fields.native, ["jsc", "sdk", "sysroot", "shell"], "inputs.native", parseNative),
    donors: exactRecord(fields.donors, DONOR_NAMES, "inputs.donors", parseTree),
    tools: exactRecord(fields.tools, TOOL_NAMES, "inputs.tools", parseFile),
    consumers: parseConsumerDependencies(fields.consumers, "inputs.consumers"),
  };
}

/** Every entry still marked draft or unresolved, by path. A production run needs none. */
export function draftEntries(manifest: InputManifest): string[] {
  const native = Object.entries(manifest.native).filter(([, root]) => root.provenance.status === "draft")
    .map(([name, root]) => `native.${name}: ${root.provenance.status === "draft" ? root.provenance.missing : ""}`);
  const relay = manifest.relay.provenance.status === "draft" ? [`relay: ${manifest.relay.provenance.missing}`] : [];
  const consumers = (["tls", "relay"] as const).flatMap(name => {
    const requirement = manifest.consumers[name];
    return requirement.status === "unresolved" ? [`consumers.${name}: ${requirement.missing}`] : [];
  });
  return native.concat(relay, consumers);
}

function parseRoots<K extends string>(value: unknown, names: readonly K[], label: string): Record<K, string> {
  return exactRecord(value, names, label, absolutePath);
}
export function parseConfig(value: unknown): C1Config {
  const fields = row(value, "config", ["schema", "sourceRoot", "manifest", "roots", "jobs"]);
  const sourceRoot = absolutePath(fields.sourceRoot, "config.sourceRoot");
  const roots = row(fields.roots, "config.roots", ["run", "qualify"], ["rehearse"]);
  const jobs = count(fields.jobs, "config.jobs", 1);
  if (jobs > 12) fail("config.jobs", "at most 12 build jobs on this workstation");
  return {
    schema: literal(fields.schema, "bun-wasm.c1-config/1", "config.schema"),
    sourceRoot,
    manifest: parseFile(fields.manifest, "config.manifest"),
    roots: {
      run: parseRoots(roots.run, ["report", "artifact", "private", "browserTmp"], "config.roots.run"),
      qualify: parseRoots(roots.qualify, ["output", "private", "browserTmp"], "config.roots.qualify"),
      ...(roots.rehearse === undefined ? {} : { rehearse: parseRoots(roots.rehearse, ["report", "private", "browserTmp"], "config.roots.rehearse") }),
    },
    jobs,
  };
}

export function parseDelivery(value: unknown): DeliveryManifest {
  const fields = row(value, "delivery", ["schema", "status", "source", "tuple", "configSha256", "inputsSha256", "files", "parentByteIntake", "consumerAcceptance", "deployment"]);
  for (const key of ["parentByteIntake", "consumerAcceptance", "deployment"]) if (fields[key] !== null) fail(`delivery.${key}`, "a producer delivery never claims intake, acceptance or deployment");
  const files = list(fields.files, "delivery.files", parseMember);
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length) fail("delivery.files", "repeated member");
  if (paths.has("DELIVERY.json")) fail("delivery.files", "the manifest never lists itself");
  return { schema: literal(fields.schema, "bun-wasm.c1-delivery/1", "delivery.schema"), status: literal(fields.status, DELIVERY_STATUS, "delivery.status"),
    source: parseSource(fields.source, "delivery.source"), tuple: parseTuple(fields.tuple, "delivery.tuple"),
    configSha256: sha256Text(fields.configSha256, "delivery.configSha256"), inputsSha256: sha256Text(fields.inputsSha256, "delivery.inputsSha256"),
    files, parentByteIntake: null, consumerAcceptance: null, deployment: null };
}

export function parseIntake(value: unknown): ParentIntake {
  const fields = row(value, "intake", ["schema", "kind", "owner", "at", "deliveryRoot", "delivery", "source", "tuple", "members", "admitted"]);
  if (fields.admitted !== true) fail("intake.admitted", "expected true");
  const at = text(fields.at, "intake.at");
  if (Number.isNaN(Date.parse(at))) fail("intake.at", "expected an ISO timestamp");
  return { schema: literal(fields.schema, "bun-wasm.c1-intake/1", "intake.schema"), kind: literal(fields.kind, "independent-parent-byte-admission", "intake.kind"),
    owner: text(fields.owner, "intake.owner"), at, deliveryRoot: absolutePath(fields.deliveryRoot, "intake.deliveryRoot"), delivery: parseFile(fields.delivery, "intake.delivery"),
    source: parseSource(fields.source, "intake.source"), tuple: parseTuple(fields.tuple, "intake.tuple"), members: count(fields.members, "intake.members", 1), admitted: true };
}

export function parseHandoff(value: unknown): ConsumerHandoff {
  const fields = row(value, "handoff", ["schema", "source", "tuple", "delivery", "intake", "artifacts", "webRoot", "dependencies", "outputs", "browserTmp"]);
  const delivery = row(fields.delivery, "handoff.delivery", ["root", "manifest"]);
  return { schema: literal(fields.schema, "bun-wasm.c1-handoff/1", "handoff.schema"), source: parseSource(fields.source, "handoff.source"), tuple: parseTuple(fields.tuple, "handoff.tuple"),
    delivery: { root: absolutePath(delivery.root, "handoff.delivery.root"), manifest: parseFile(delivery.manifest, "handoff.delivery.manifest") },
    intake: parseFile(fields.intake, "handoff.intake"), artifacts: exactRecord(fields.artifacts, HANDOFF_ROLES, "handoff.artifacts", parseFile),
    webRoot: absolutePath(fields.webRoot, "handoff.webRoot"),
    dependencies: parseConsumerDependencies(fields.dependencies, "handoff.dependencies"), outputs: exactRecord(fields.outputs, CONSUMERS, "handoff.outputs", absolutePath),
    browserTmp: absolutePath(fields.browserTmp, "handoff.browserTmp") };
}
