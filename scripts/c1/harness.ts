import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceIdentity } from "./contract.ts";
import { isDeepStrictEqual } from "node:util";
import { sameSource } from "./contract.ts";
import { requireFile } from "./identity.ts";
import { git } from "./inputs.ts";
import { parseReviewReconciliation, requireHarnessCheckout, type AdmittedProduct, type HarnessIdentity } from "./replay.ts";
import { tlsPagePaths } from "../producer-closure.ts";

/**
 * Every path a consumer harness may change relative to the product source.
 * Exact files, never prefixes: the producer's stages, publication, TLS page
 * builder, guest and host sources, build scripts, pins, locks, patches and
 * native inputs are all outside it, and so are the two TLS driver modules the
 * sealed TLS page bundles (tls-qualification-context.ts and
 * tls-qualification-lifecycle.ts). Widening it is itself a reviewed change.
 */
export const CONSUMER_HARNESS_PATHS: readonly string[] = [
  // Controller: CLI, consumer replay, its input-admission split and handoff checks.
  "scripts/c1-controller.ts", "scripts/c1/operations.ts", "scripts/c1/inputs.ts", "scripts/c1/delivery.ts", "scripts/c1/loaded.ts",
  "scripts/c1/replay.ts", "scripts/c1/harness.ts", "scripts/c1/host-tools.ts",
  // Controller tests and their synthetic fixture.
  "scripts/c1/contract-fixture.ts", "scripts/c1/contract.test.ts", "scripts/c1/controller.test.ts", "scripts/c1/tls.test.ts", "scripts/c1/replay.test.ts",
  // Five-owner Chromium driver.
  "scripts/consumer-process-groups.ts", "scripts/io-resource-context.ts", "scripts/io-resource-context-intake.ts", "scripts/io-resource-context-assets.ts", "scripts/io-resource-context.test.ts",
  // TLS driver and its host-side services, without the modules the sealed page bundles.
  "scripts/tls-qualification.ts", "scripts/tls-qualification-inputs.ts", "scripts/tls-qualification-fixture.ts", "scripts/tls-qualification.test.ts",
  "web/tests/tls-relay-services.ts", "web/tests/tls-relay-browser.ts",
  // The Pi PostgreSQL owner the TLS driver sends to the Pi; no producer stage or sealed page reads it.
  "tests/servers/tls.ts",
  // The check manifest and records that describe this harness.
  "checks/web-c1-replay.json", "docs/bun-patches/c1-consumer-replay.md", ".internal/engines/c1-controller.md",
  // Unused-code configuration: host tools are no longer called by name.
  "knip.json",
];

/** Reads one public GitHub REST resource, unauthenticated. Tests pass a recorded reader. */
export type GitHubRead = (resource: string) => Promise<unknown>;
export const publicGitHub: GitHubRead = async resource => {
  const response = await fetch(`https://api.github.com/${resource}`, { headers: { accept: "application/vnd.github+json", "user-agent": "bun-wasm-c1-replay" } });
  if (!response.ok) throw new HarnessError(`GitHub ${resource} answered ${response.status}`);
  return await response.json() as unknown;
};

/** What admission observed, recorded in the replay result next to the product identity. */
export interface HarnessEvidence {
  readonly harness: HarnessIdentity;
  readonly product: SourceIdentity;
  readonly changedPaths: readonly string[];
  readonly pullRequest: { readonly url: string; readonly mergedAt: string; readonly mergeCommit: string; readonly head: string; readonly base: HarnessIdentity["targetBranch"]; readonly branchHead: string };
  readonly review: ReturnType<typeof requireReview>;
}

class HarnessError extends Error {}
function fail(message: string): never { throw new HarnessError(message); }
function field(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((at, key) => at && typeof at === "object" && key in at ? (at as Record<string, unknown>)[key] : undefined, value);
}

/** Paths the harness commit changes relative to the product commit, which must be its ancestor. */
export function changedPaths(root: string, product: SourceIdentity, harness: SourceIdentity): string[] {
  try { git(root, ["merge-base", "--is-ancestor", product.head, harness.head]); }
  catch { fail(`product source ${product.head} is not an ancestor of the harness ${harness.head}`); }
  if (git(root, ["rev-parse", `${product.head}^{tree}`]) !== product.tree) fail("product commit has another tree than the product source names");
  const output = git(root, ["diff", "--name-only", "--no-renames", "-z", product.head, harness.head]);
  return output.split("\0").filter(Boolean).sort();
}
/** Refuses every changed path outside the exact consumer list. */
export function requireConsumerPaths(paths: readonly string[]): void {
  const outside = paths.filter(path => !CONSUMER_HARNESS_PATHS.includes(path));
  if (outside.length) fail(`harness changes product source or build inputs: ${outside.join(", ")}`);
}

/**
 * No changed path is a bundled input of the sealed TLS page. Its receipt is a
 * sealed member; the TLS consumer later re-hashes every input against the
 * staged harness checkout (verifyTlsPage), after its dependencies exist.
 */
export function requireUnbundled(product: AdmittedProduct, paths: readonly string[]): void {
  const receipt: unknown = JSON.parse(readFileSync(join(product.delivery.root, tlsPagePaths.receipt), "utf8"));
  const inputs = field(receipt, "inputs");
  if (!Array.isArray(inputs) || inputs.some(input => typeof field(input, "path") !== "string")) fail("sealed TLS page receipt has no input list");
  const bundled = new Set(inputs.map(input => field(input, "path")));
  const changed = paths.filter(path => bundled.has(path));
  if (changed.length) fail(`harness changes inputs the sealed TLS page bundles: ${changed.join(", ")}`);
}

/**
 * The public merge facts: the pull request merged into the harness target
 * branch of this repository at exactly the harness commit, from exactly the
 * reviewed candidate, the candidate's tree is the merged tree, and that
 * branch's head is still the harness commit. Main is never consulted, so its
 * later commits can neither admit nor enter a replay.
 */
async function requireMerged(harness: HarnessIdentity, read: GitHubRead): Promise<HarnessEvidence["pullRequest"]> {
  const pull = await read(`repos/${harness.repository}/pulls/${harness.pullRequest}`);
  if (field(pull, "merged") !== true || typeof field(pull, "merged_at") !== "string") fail(`pull request #${harness.pullRequest} is not merged`);
  if (field(pull, "merge_commit_sha") !== harness.source.head) fail(`pull request #${harness.pullRequest} merged as ${String(field(pull, "merge_commit_sha"))}, not the harness ${harness.source.head}`);
  if (field(pull, "base.ref") !== harness.targetBranch || field(pull, "base.repo.full_name") !== harness.repository) fail(`pull request #${harness.pullRequest} did not merge into ${harness.repository} ${harness.targetBranch}`);
  if (field(pull, "head.sha") !== harness.review.candidate.head) fail(`pull request #${harness.pullRequest} head ${String(field(pull, "head.sha"))} is not the reviewed candidate`);
  const tree = async (commit: string) => field(await read(`repos/${harness.repository}/git/commits/${commit}`), "tree.sha");
  if (await tree(harness.review.candidate.head) !== harness.review.candidate.tree) fail("reviewed candidate tree differs from GitHub's");
  if (await tree(harness.source.head) !== harness.source.tree) fail("merged commit tree differs from GitHub's");
  if (harness.review.candidate.tree !== harness.source.tree) fail("the merged tree is not the reviewed candidate tree");
  const branch = await read(`repos/${harness.repository}/git/ref/heads/${harness.targetBranch}`);
  if (field(branch, "ref") !== `refs/heads/${harness.targetBranch}` || field(branch, "object.type") !== "commit") fail(`${harness.targetBranch} is not a branch of ${harness.repository}`);
  if (field(branch, "object.sha") !== harness.source.head) fail(`${harness.targetBranch} head ${String(field(branch, "object.sha"))} is not the harness ${harness.source.head}`);
  return { url: String(field(pull, "html_url")), mergedAt: String(field(pull, "merged_at")), mergeCommit: harness.source.head, head: harness.review.candidate.head,
    base: harness.targetBranch, branchHead: harness.source.head };
}
/** The untouched independent review and a separate, byte-pinned coordinator correction record. */
export function requireReview(harness: HarnessIdentity) {
  const artifact = requireFile(harness.review.artifact, "harness review artifact");
  const review: unknown = JSON.parse(readFileSync(artifact.path, "utf8"));
  const verdict = field(review, "verdict");
  if (field(review, "schema") !== "bun-wasm.independent-consumer-replay-review/1" || field(review, "sourceReviewComplete") !== true) fail("harness independent review is incomplete");
  if (verdict !== "PASS" && verdict !== "CHANGES REQUESTED") fail("harness independent review has no completed verdict");
  if (field(review, "approved") !== (verdict === "PASS")) fail("harness independent review verdict and approval differ");
  const findings = reviewFindings(review, verdict);
  const reconciliation = requireFile(harness.review.reconciliation, "harness review reconciliation");
  const correction = parseReviewReconciliation(JSON.parse(readFileSync(reconciliation.path, "utf8")));
  if (!isDeepStrictEqual(correction.review, artifact)) fail("reconciliation names another independent review");
  if (!isDeepStrictEqual(field(review, "candidate"), correction.reviewed)) fail("independent review does not name the reconciled commit and tree");
  if (!sameSource(correction.candidate, harness.review.candidate)) fail("reconciliation names another final candidate");
  const paths = changedPaths(harness.sourceRoot, correction.reviewed, correction.candidate);
  requireConsumerPaths(paths);
  if (!isDeepStrictEqual(paths, correction.changedPaths)) fail("correction diff differs from the reconciliation");
  if (!isDeepStrictEqual(findings, correction.resolvedFindings.toSorted())) fail("reconciliation does not resolve every independent finding exactly once");
  if (paths.length && !findings.length) fail("candidate changed after a finding-free review");
  if (findings.length && !correction.evidence.length) fail("finding resolutions have no test evidence");
  const evidence = correction.evidence.map(identity => requireFile(identity, "review correction evidence"));
  return { artifact, reconciliation, evidence };
}
function reviewFindings(review: unknown, verdict: string): string[] {
  const rows = field(review, "findings");
  if (!Array.isArray(rows)) fail("independent review has no findings list");
  const ids = rows.map(row => field(row, "id"));
  if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) fail("independent finding IDs must be unique non-empty strings");
  if ((verdict === "PASS") !== (ids.length === 0)) fail("independent review verdict and findings differ");
  return (ids as string[]).sort();
}
/** Protect every pinned review and correction artifact from the replay output roots. */
export function reviewProtectedPaths(harness: HarnessIdentity): string[] {
  const reference = requireFile(harness.review.reconciliation, "harness review reconciliation");
  const correction = parseReviewReconciliation(JSON.parse(readFileSync(reference.path, "utf8")));
  return [harness.review.artifact.path, reference.path].concat(correction.evidence.map(identity => identity.path));
}

/**
 * Admission of the consumer harness, before any setup: the running checkout
 * is the clean merged commit, its diff from the product source is consumer
 * paths only, the sealed TLS page's bundled inputs are byte-identical in it,
 * and the public merge facts and the pinned review bind it.
 */
export async function admitHarness(harness: HarnessIdentity, controllerRoot: string, product: AdmittedProduct, read: GitHubRead): Promise<HarnessEvidence> {
  requireHarnessCheckout(harness, controllerRoot);
  const source = product.delivery.manifest.source;
  const paths = changedPaths(harness.sourceRoot, source, harness.source);
  requireConsumerPaths(paths);
  requireUnbundled(product, paths);
  const review = requireReview(harness);
  const pullRequest = await requireMerged(harness, read);
  return { harness, product: source, changedPaths: paths, pullRequest, review };
}
