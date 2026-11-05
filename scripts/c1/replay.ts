import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseHandoff, sameSource, sameTuple, sha256Text, type ConsumerHandoff, type FileIdentity, type ReleaseTuple, type SourceIdentity } from "./contract.ts";
import { admitIntake, buildHandoff, readSealedDelivery, requireSealedArtifacts, type SealedDelivery } from "./delivery.ts";
import { fileIdentity, requireFile, sameBytes, sha256 } from "./identity.ts";
import { cleanSource } from "./inputs.ts";

/**
 * The consumer replay contract. It keeps two identities apart:
 *
 * - The product: one admitted sealed delivery, exactly as produced. Its
 *   source, config, inputs and intake are the producer's own records; the
 *   replay never relabels, rebuilds or reseals any of them.
 * - The consumer harness: the merged, reviewed checkout whose controller and
 *   drivers run the consumers. Its diff from the product source may touch
 *   only the consumer paths `harness.ts` lists.
 *
 * Host tools the consumers call that are not product tools are declared here
 * at absolute paths with their bytes and version line; nothing is found
 * through an ambient PATH.
 */

/** Host executables the TLS consumer runs directly; product tools (bun, git, bash) stay in the product input manifest. */
export const HOST_TOOL_NAMES = ["mesh", "flock", "sh", "cat", "findmnt", "ps", "tar", "gzip"] as const;
export type HostToolName = typeof HOST_TOOL_NAMES[number];
/** An absolute regular executable, its exact bytes, and the first line its version command prints. */
export interface HostTool extends FileIdentity { readonly version: { readonly args: readonly string[]; readonly line: string } }
export type HostTools = Readonly<Record<HostToolName, HostTool>>;

/** The admitted product, named by the producer's and the independent parent's own records. */
export interface ProductIdentity {
  readonly config: FileIdentity;
  readonly intake: FileIdentity;
  readonly delivery: FileIdentity;
  readonly source: SourceIdentity;
  readonly tuple: ReleaseTuple;
  readonly members: number;
}
/** The consumer harness: a merged pull request's commit, and the independent review of the candidate it merged. */
export interface HarnessIdentity {
  readonly sourceRoot: string;
  readonly source: SourceIdentity;
  readonly repository: string;
  readonly pullRequest: number;
  readonly review: { readonly artifact: FileIdentity; readonly candidate: SourceIdentity; readonly reconciliation: FileIdentity };
}
/** The first qualification's output. It stays as it is; the replay only reads and pins it. */
export interface OriginalQualification {
  readonly output: string;
  readonly handoff: FileIdentity;
  readonly qualification: FileIdentity;
  readonly native: Readonly<Record<typeof NOT_RERUN[number], FileIdentity>>;
}
export interface ReplayRoots { readonly output: string; readonly private: string; readonly browserTmp: string }
export interface ReplayContract {
  readonly schema: "bun-wasm.c1-replay/1";
  readonly product: ProductIdentity;
  readonly harness: HarnessIdentity;
  readonly original: OriginalQualification;
  readonly hostTools: HostTools;
  readonly roots: ReplayRoots;
}
/** What every replayed consumer receives: the pinned contract, both identities, and the product view of the sealed delivery. */
export interface ReplayHandoff {
  readonly schema: "bun-wasm.c1-replay-handoff/1";
  readonly replay: FileIdentity;
  readonly harness: HarnessIdentity;
  readonly hostTools: HostTools;
  readonly product: ConsumerHandoff;
}
/**
 * What the replay runs. Native QuickJS and JSC keep the first
 * qualification's observations and are never rerun; Relay stays not run.
 */
export const REPLAYED = { fiveOwner: ["chromium"], tls: ["pg-early"] } as const;
export const NOT_RERUN = ["quickjs", "jsc"] as const;

class ReplayError extends Error {}
function fail(message: string): never { throw new ReplayError(message); }

type Row = Record<string, unknown>;
function row(value: unknown, label: string, keys: readonly string[]): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected an object`);
  const fields = value as Row;
  const actual = Object.keys(fields).sort().join(",");
  if (actual !== keys.toSorted().join(",")) fail(`${label}: expected exactly ${keys.join(", ")}`);
  return fields;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") fail(`${label}: expected non-empty text`);
  return value;
}
function hex40(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) fail(`${label}: expected 40 lowercase hex digits`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${label}: expected a positive integer`);
  return value;
}
function absolute(value: unknown, label: string): string {
  const path = text(value, label);
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") fail(`${label}: expected a canonical absolute path`);
  return path;
}
function file(value: unknown, label: string): FileIdentity {
  const fields = row(value, label, ["path", "bytes", "sha256"]);
  const bytes = fields.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) fail(`${label}.bytes: expected a byte count`);
  return { path: absolute(fields.path, `${label}.path`), bytes, sha256: sha256Text(fields.sha256, `${label}.sha256`) };
}
function source(value: unknown, label: string): SourceIdentity {
  const fields = row(value, label, ["head", "tree"]);
  return { head: hex40(fields.head, `${label}.head`), tree: hex40(fields.tree, `${label}.tree`) };
}
function tuple(value: unknown, label: string): ReleaseTuple {
  const fields = row(value, label, ["runtime", "relay", "programs", "programManifestSchema", "hostInterface"]);
  return { runtime: text(fields.runtime, `${label}.runtime`), relay: text(fields.relay, `${label}.relay`), programs: text(fields.programs, `${label}.programs`),
    programManifestSchema: text(fields.programManifestSchema, `${label}.programManifestSchema`), hostInterface: integer(fields.hostInterface, `${label}.hostInterface`) };
}
function hostTool(value: unknown, label: string): HostTool {
  const fields = row(value, label, ["path", "bytes", "sha256", "version"]);
  const version = row(fields.version, `${label}.version`, ["args", "line"]);
  if (!Array.isArray(version.args) || version.args.some(arg => typeof arg !== "string")) fail(`${label}.version.args: expected a list of arguments`);
  return { ...file({ path: fields.path, bytes: fields.bytes, sha256: fields.sha256 }, label), version: { args: version.args as string[], line: text(version.line, `${label}.version.line`) } };
}
function hostTools(value: unknown, label: string): HostTools {
  const fields = row(value, label, HOST_TOOL_NAMES);
  return Object.fromEntries(HOST_TOOL_NAMES.map(name => [name, hostTool(fields[name], `${label}.${name}`)])) as Record<HostToolName, HostTool>;
}
function harness(value: unknown, label: string): HarnessIdentity {
  const fields = row(value, label, ["sourceRoot", "source", "repository", "pullRequest", "review"]);
  const review = row(fields.review, `${label}.review`, ["artifact", "candidate", "reconciliation"]);
  const repository = text(fields.repository, `${label}.repository`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail(`${label}.repository: expected owner/name`);
  return { sourceRoot: absolute(fields.sourceRoot, `${label}.sourceRoot`), source: source(fields.source, `${label}.source`), repository,
    pullRequest: integer(fields.pullRequest, `${label}.pullRequest`),
    review: { artifact: file(review.artifact, `${label}.review.artifact`), candidate: source(review.candidate, `${label}.review.candidate`),
      reconciliation: file(review.reconciliation, `${label}.review.reconciliation`) } };
}

/** Independent findings stay unchanged; the coordinator pins their corrections separately. */
export interface ReviewReconciliation {
  readonly schema: "bun-wasm.c1-review-reconciliation/1";
  readonly review: FileIdentity;
  readonly reviewed: SourceIdentity;
  readonly candidate: SourceIdentity;
  readonly changedPaths: readonly string[];
  readonly resolvedFindings: readonly string[];
  readonly evidence: readonly FileIdentity[];
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item === "")) fail(`${label}: expected non-empty strings`);
  return value as string[];
}
export function parseReviewReconciliation(value: unknown): ReviewReconciliation {
  const fields = row(value, "review reconciliation", ["schema", "review", "reviewed", "candidate", "changedPaths", "resolvedFindings", "evidence"]);
  if (fields.schema !== "bun-wasm.c1-review-reconciliation/1") fail("invalid review reconciliation schema");
  if (!Array.isArray(fields.evidence)) fail("review reconciliation evidence must be a list");
  return { schema: "bun-wasm.c1-review-reconciliation/1", review: file(fields.review, "reconciliation.review"),
    reviewed: source(fields.reviewed, "reconciliation.reviewed"), candidate: source(fields.candidate, "reconciliation.candidate"),
    changedPaths: strings(fields.changedPaths, "reconciliation.changedPaths"), resolvedFindings: strings(fields.resolvedFindings, "reconciliation.resolvedFindings"),
    evidence: fields.evidence.map(value => file(value, "reconciliation.evidence")) };
}

export function parseReplay(value: unknown): ReplayContract {
  const fields = row(value, "replay", ["schema", "product", "harness", "original", "hostTools", "roots"]);
  if (fields.schema !== "bun-wasm.c1-replay/1") fail("replay.schema: expected bun-wasm.c1-replay/1");
  const product = row(fields.product, "replay.product", ["config", "intake", "delivery", "source", "tuple", "members"]);
  const original = row(fields.original, "replay.original", ["output", "handoff", "qualification", "native"]);
  const native = row(original.native, "replay.original.native", NOT_RERUN);
  const roots = row(fields.roots, "replay.roots", ["output", "private", "browserTmp"]);
  return {
    schema: "bun-wasm.c1-replay/1",
    product: { config: file(product.config, "replay.product.config"), intake: file(product.intake, "replay.product.intake"), delivery: file(product.delivery, "replay.product.delivery"),
      source: source(product.source, "replay.product.source"), tuple: tuple(product.tuple, "replay.product.tuple"), members: integer(product.members, "replay.product.members") },
    harness: harness(fields.harness, "replay.harness"),
    original: { output: absolute(original.output, "replay.original.output"), handoff: file(original.handoff, "replay.original.handoff"),
      qualification: file(original.qualification, "replay.original.qualification"), native: { quickjs: file(native.quickjs, "replay.original.native.quickjs"), jsc: file(native.jsc, "replay.original.native.jsc") } },
    hostTools: hostTools(fields.hostTools, "replay.hostTools"),
    roots: { output: absolute(roots.output, "replay.roots.output"), private: absolute(roots.private, "replay.roots.private"), browserTmp: absolute(roots.browserTmp, "replay.roots.browserTmp") },
  };
}
export function parseReplayHandoff(value: unknown): ReplayHandoff {
  const fields = row(value, "replay handoff", ["schema", "replay", "harness", "hostTools", "product"]);
  if (fields.schema !== "bun-wasm.c1-replay-handoff/1") fail("replay handoff schema: expected bun-wasm.c1-replay-handoff/1");
  return { schema: "bun-wasm.c1-replay-handoff/1", replay: file(fields.replay, "replay handoff.replay"), harness: harness(fields.harness, "replay handoff.harness"),
    hostTools: hostTools(fields.hostTools, "replay handoff.hostTools"), product: parseHandoff(fields.product) };
}

export interface LoadedReplay { readonly identity: FileIdentity; readonly contract: ReplayContract }
/** The contract by its exact bytes. */
export function loadReplay(path: string, expectedSha256: string): LoadedReplay {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedSha256) fail("replay contract bytes differ from the pinned SHA-256");
  return { identity: { path, bytes: bytes.byteLength, sha256: expectedSha256 }, contract: parseReplay(JSON.parse(bytes.toString("utf8"))) };
}

export interface AdmittedProduct { readonly delivery: SealedDelivery; readonly intake: FileIdentity }
/**
 * The exact sealed delivery, intake, config and inputs the contract names:
 * every member re-hashed with its sealed mode, the intake naming this
 * delivery, and source, tuple and member count as produced.
 */
export function admitProduct(product: ProductIdentity): AdmittedProduct {
  const delivery = readSealedDelivery(dirname(product.delivery.path));
  if (delivery.identity.path !== product.delivery.path || !sameBytes(delivery.identity, product.delivery)) fail("sealed DELIVERY.json differs from the replay's product");
  const intake = admitIntake(product.intake.path, product.intake.sha256, delivery);
  if (!sameBytes(intake.identity, product.intake)) fail("intake differs from the replay's product");
  if (!sameSource(delivery.manifest.source, product.source) || !sameTuple(delivery.manifest.tuple, product.tuple)) fail("delivery source or tuple differs from the replay's product");
  if (delivery.manifest.files.length !== product.members) fail("delivery member count differs from the replay's product");
  const config = requireFile(product.config, "product config");
  if (config.sha256 !== delivery.manifest.configSha256) fail("product config is not the one the delivery seals");
  return { delivery, intake: intake.identity };
}

/** The one handoff a contract, its sealed delivery and intake derive. Outputs are the replay's own fresh roots. */
export function deriveReplayHandoff(replay: LoadedReplay, product: AdmittedProduct): ReplayHandoff {
  const { delivery } = product;
  const view = buildHandoff(delivery, product.intake, delivery.inputs.consumers, delivery.config.fixtures, replay.contract.roots.output, replay.contract.roots.browserTmp);
  return { schema: "bun-wasm.c1-replay-handoff/1", replay: replay.identity, harness: replay.contract.harness, hostTools: replay.contract.hostTools, product: view };
}

/**
 * What every replayed consumer checks before use: the pinned contract still
 * has its bytes, its product is admitted again, the handoff is exactly the
 * one they derive, and every sealed artifact keeps its bytes and mode.
 */
export function requireReplayHandoff(handoff: ReplayHandoff): AdmittedProduct {
  const replay = loadReplay(handoff.replay.path, handoff.replay.sha256);
  if (replay.identity.bytes !== handoff.replay.bytes) fail("replay contract size differs from the handoff's pin");
  const product = admitProduct(replay.contract.product);
  if (!isDeepStrictEqual(deriveReplayHandoff(replay, product), handoff)) fail("replay handoff differs from the one its contract, sealed delivery and intake derive");
  requireSealedArtifacts(handoff.product);
  return product;
}
export interface PinnedReplay { readonly handoff: ReplayHandoff; readonly reference: FileIdentity; readonly product: AdmittedProduct }
/** A consumer's whole replay admission from its pinned handoff file. */
export function admitReplayHandoffFile(path: string, expectedSha256: string): PinnedReplay {
  sha256Text(expectedSha256, "handoff SHA-256");
  const reference = fileIdentity(resolve(path));
  if (reference.sha256 !== expectedSha256) fail("handoff bytes differ from the pinned SHA-256");
  const handoff = parseReplayHandoff(JSON.parse(readFileSync(reference.path, "utf8")));
  return { handoff, reference, product: requireReplayHandoff(handoff) };
}

/** The consumer runs from the harness checkout itself, clean at the merged commit. */
export function requireHarnessCheckout(harness: HarnessIdentity, root: string): void {
  if (realpathSync(root) !== realpathSync(harness.sourceRoot)) fail(`consumer runs from ${root}, not the harness checkout ${harness.sourceRoot}`);
  const actual = cleanSource(root);
  if (!sameSource(actual, harness.source)) fail(`harness checkout is ${actual.head}/${actual.tree}, the replay names ${harness.source.head}/${harness.source.tree}`);
}
/** A declared host tool still has its bytes; consumers call it only by this absolute path. */
export function hostToolPath(tools: HostTools, name: HostToolName): string {
  return requireFile(tools[name], `host tool ${name}`).path;
}
