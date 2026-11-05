import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { qualificationFixture, type TlsFixture } from "../tls-qualification-fixture.ts";
import { fixtureHostTools } from "./contract-fixture.ts";
import { CONSUMER_HARNESS_PATHS, admitHarness, changedPaths, requireConsumerPaths, requireReview, requireUnbundled, type GitHubRead } from "./harness.ts";
import { admitHostTool, admitHostTools } from "./host-tools.ts";
import { fileIdentity, sha256 } from "./identity.ts";
import { replay } from "./operations.ts";
import { admitProduct, parseReplay, type AdmittedProduct, type HarnessIdentity, type ReplayContract } from "./replay.ts";
import { TLS_PAGE_ENTRY, TLS_PAGE_WORKERS } from "./tls-page.ts";

/** Synthetic fixtures only: a fixture Git host, a sealed fixture delivery and recorded GitHub answers. None of it is product evidence. */
const repository = resolve(import.meta.dir, "../..");
const opened: TlsFixture[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const fixture of opened.splice(0)) fixture.close();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-c1-replay-"));
  scratch.push(root);
  return root;
}
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim(); }
function commit(root: string, path: string, content: string): { head: string; tree: string } {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, "add", "-A");
  git(root, "-c", "user.email=replay@test.invalid", "-c", "user.name=Replay fixture", "commit", "-qm", `change ${path}`);
  return { head: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
}
function reviewFile(root: string, candidate: { head: string; tree: string }, verdict = "PASS"): string {
  const path = join(root, `review-${candidate.head.slice(0, 8)}-${verdict}.md`);
  writeFileSync(path, `# Synthetic independent review\n\n## Verdict\n\n${verdict}. No findings.\n\nReviewed candidate ${candidate.head}, tree ${candidate.tree}.\n`);
  return path;
}

/** A fixture whose host checkout gains one more commit: the harness, with the fixture's product commit as its base. */
async function harnessFixture(path = "scripts/io-resource-context.ts") {
  const f = await qualificationFixture();
  opened.push(f);
  const contract = parseReplay(JSON.parse(readFileSync(f.replay, "utf8")));
  const product: AdmittedProduct = admitProduct(contract.product);
  const source = commit(f.host, path, "// synthetic consumer harness change\n");
  const harness: HarnessIdentity = { sourceRoot: f.host, source, repository: "fixture/bun-wasm", pullRequest: 7,
    review: { artifact: fileIdentity(reviewFile(f.root, source)), candidate: source } };
  return { f, contract, product, harness };
}
type Facts = Record<string, Record<string, unknown>>;
/** Recorded public answers GitHub gives for a merged pull request. `edit` changes one fact. */
function recorded(harness: HarnessIdentity, edit: (facts: Facts) => void = () => {}): GitHubRead & { readonly reads: string[] } {
  const base = `repos/${harness.repository}`;
  const facts: Facts = {
    [`${base}/pulls/${harness.pullRequest}`]: { merged: true, merged_at: "2026-11-05T00:00:00Z", merge_commit_sha: harness.source.head, html_url: "https://github.com/fixture/bun-wasm/pull/7",
      base: { ref: "main", repo: { full_name: harness.repository } }, head: { sha: harness.review.candidate.head } },
    [`${base}/git/commits/${harness.review.candidate.head}`]: { tree: { sha: harness.review.candidate.tree } },
    [`${base}/git/commits/${harness.source.head}`]: { tree: { sha: harness.source.tree } },
  };
  edit(facts);
  const reads: string[] = [];
  const read = async (resource: string) => {
    reads.push(resource);
    const value = facts[resource];
    if (!value) throw new Error(`no recorded ${resource}`);
    return value;
  };
  return Object.assign(read, { reads });
}

test("the consumer list is exact files and refuses product, build, native, package, lock and page paths", () => {
  for (const path of CONSUMER_HARNESS_PATHS) {
    expect(path).not.toMatch(/[*/]$/);
    expect(existsSync(join(repository, path))).toBe(true);
  }
  expect(() => requireConsumerPaths(CONSUMER_HARNESS_PATHS)).not.toThrow();
  const product = ["src/assets.ts", "crates/bunwasm-runtime/src/engine.rs", "web/src/net/relay.ts", "web/serve.ts", "web/tests/tls-relay-page.ts",
    "scripts/c1/stages.ts", "scripts/c1/steps.ts", "scripts/c1/step.ts", "scripts/c1/publication.ts", "scripts/c1/tls-page.ts", "scripts/c1/native-header.ts",
    "scripts/c1/admission.ts", "scripts/c1/contract.ts", "scripts/producer-closure.ts", "scripts/engine-producer.ts", "scripts/build.sh", "scripts/build-bun-browser.sh",
    "scripts/sync-bun.sh", "scripts/waffle-release-inputs.json", "patches/bun/0001-wasi.patch", "jsc/common.sh", "jsc/webkit-wasi.patch", "env.sh",
    "package.json", "bun.lock", "web/package.json", "web/bun.lock", "sandbox/bun.lock", "Cargo.toml", "Cargo.lock",
    "scripts/tls-qualification-lifecycle.ts", "scripts/tls-qualification-context.ts", "scripts/c1"];
  for (const path of product) expect(() => requireConsumerPaths([path])).toThrow(`harness changes product source or build inputs: ${path}`);
});

const transpiler = new Bun.Transpiler({ loader: "ts" });
/** Repository-relative modules a TypeScript entry reaches through relative imports. */
function importClosure(entries: readonly string[], seen = new Set<string>()): Set<string> {
  for (const path of entries.filter(entry => !seen.has(entry) && existsSync(join(repository, entry)))) {
    seen.add(path);
    const imports = transpiler.scanImports(readFileSync(join(repository, path), "utf8")).map(entry => entry.path).filter(specifier => specifier.startsWith("."));
    importClosure(imports.map(specifier => relative(repository, resolve(dirname(join(repository, path)), specifier))), seen);
  }
  return seen;
}
test("no consumer path is a module the sealed TLS page bundles or a producer stage action", () => {
  const page = importClosure([TLS_PAGE_ENTRY].concat(TLS_PAGE_WORKERS));
  expect(page.has("scripts/tls-qualification-lifecycle.ts")).toBe(true);
  expect(CONSUMER_HARNESS_PATHS.filter(path => page.has(path))).toEqual([]);
  const stages = ["scripts/c1/stages.ts", "scripts/c1/steps.ts", "scripts/c1/step.ts", "scripts/c1/publication.ts", "scripts/c1/tls-page.ts", "scripts/c1/native-header.ts",
    "scripts/engine-producer.ts", "scripts/jsc-embedding.ts", "scripts/test-web-guests.ts", "scripts/browser-build.ts", "scripts/producer-closure.ts"];
  expect(CONSUMER_HARNESS_PATHS.filter(path => stages.includes(path))).toEqual([]);
});

test("a merged, reviewed, consumer-only harness is admitted with both identities in its evidence", async () => {
  const { f, product, harness } = await harnessFixture();
  const read = recorded(harness);
  const evidence = await admitHarness(harness, f.host, product, read);
  expect(evidence.product).toEqual(f.source);
  expect(evidence.harness.source).toEqual(harness.source);
  expect(evidence.changedPaths).toEqual(["scripts/io-resource-context.ts"]);
  expect(evidence.pullRequest).toEqual({ url: "https://github.com/fixture/bun-wasm/pull/7", mergedAt: "2026-11-05T00:00:00Z", mergeCommit: harness.source.head, head: harness.source.head, base: "main" });
  expect(evidence.review).toEqual(harness.review.artifact);
});

test.each([
  ["not merged", (facts: Facts, pull: string) => { facts[pull] = { ...facts[pull], merged: false }; }, "is not merged"],
  ["merged as another commit", (facts: Facts, pull: string) => { facts[pull] = { ...facts[pull], merge_commit_sha: "a".repeat(40) }; }, "merged as"],
  ["merged into another branch", (facts: Facts, pull: string) => { facts[pull] = { ...facts[pull], base: { ref: "release", repo: { full_name: "fixture/bun-wasm" } } }; }, "did not merge into fixture/bun-wasm main"],
  ["merged from another head", (facts: Facts, pull: string) => { facts[pull] = { ...facts[pull], head: { sha: "b".repeat(40) } }; }, "is not the reviewed candidate"],
] as const)("public merge facts refuse a pull request %s", async (_name, edit, message) => {
  const { f, product, harness } = await harnessFixture();
  const read = recorded(harness, facts => edit(facts, `repos/${harness.repository}/pulls/${harness.pullRequest}`));
  await expect(admitHarness(harness, f.host, product, read)).rejects.toThrow(message);
});

test("a reviewed candidate whose tree is not the merged tree refuses", async () => {
  const { f, product, harness } = await harnessFixture();
  const candidate = f.source;
  const reviewed: HarnessIdentity = { ...harness, review: { artifact: fileIdentity(reviewFile(f.root, candidate)), candidate } };
  await expect(admitHarness(reviewed, f.host, product, recorded(reviewed))).rejects.toThrow("the merged tree is not the reviewed candidate tree");
  const wrong = recorded(harness, facts => { facts[`repos/${harness.repository}/git/commits/${harness.source.head}`] = { tree: { sha: "c".repeat(40) } }; });
  await expect(admitHarness(harness, f.host, product, wrong)).rejects.toThrow("tree differs from GitHub's");
});

test("the review artifact is pinned by bytes and must name the candidate and a PASS verdict", async () => {
  const { f, harness } = await harnessFixture();
  expect(requireReview(harness)).toEqual(harness.review.artifact);
  const failed = reviewFile(f.root, harness.source, "FAIL");
  expect(() => requireReview({ ...harness, review: { ...harness.review, artifact: fileIdentity(failed) } })).toThrow("no PASS verdict");
  const other = reviewFile(f.root, f.source);
  expect(() => requireReview({ ...harness, review: { ...harness.review, artifact: fileIdentity(other) } })).toThrow("does not name the reviewed candidate");
  appendFileSync(harness.review.artifact.path, "edited\n");
  expect(() => requireReview(harness)).toThrow("harness review artifact changed");
});

test("dirty, foreign, product-changing or page-input-changing harnesses refuse before any GitHub read", async () => {
  const { f, product, harness } = await harnessFixture();
  const read = recorded(harness);
  writeFileSync(join(f.host, "untracked.txt"), "dirty\n");
  await expect(admitHarness(harness, f.host, product, read)).rejects.toThrow("dirty");
  rmSync(join(f.host, "untracked.txt"));
  await expect(admitHarness(harness, fresh(), product, read)).rejects.toThrow("not the harness checkout");
  const changed = commit(f.host, "web/src/runner.ts", "export const changed = true;\n");
  await expect(admitHarness({ ...harness, source: changed }, f.host, product, read)).rejects.toThrow("product source or build inputs: web/src/runner.ts");
  expect(() => requireUnbundled(product, ["web/src/worker.ts"])).toThrow("inputs the sealed TLS page bundles: web/src/worker.ts");
  expect(read.reads).toEqual([]);
});

test("the product commit must be the harness's ancestor with its stated tree", async () => {
  const { f, harness } = await harnessFixture();
  expect(() => changedPaths(f.host, harness.source, f.source)).toThrow("is not an ancestor");
  expect(() => changedPaths(f.host, { ...f.source, tree: "d".repeat(40) }, harness.source)).toThrow("another tree");
});

test("host tools are admitted by resolved path, bytes, execute bit, PATH resolution and version line", () => {
  const root = fresh();
  const tools = fixtureHostTools(join(root, "tools"));
  const empty = join(root, "empty");
  mkdirSync(empty);
  const env = { PATH: empty };
  expect(admitHostTools(tools, env).mesh).toEqual({ path: tools.mesh.path, bytes: tools.mesh.bytes, sha256: tools.mesh.sha256, versionLine: "fixture mesh" });
  expect(() => admitHostTool({ ...tools, mesh: { ...tools.mesh, version: { args: ["--version"], line: "mesh version v0.1.249" } } }, "mesh", env)).toThrow('reports "fixture mesh"');
  const shadow = join(root, "shadow");
  mkdirSync(shadow);
  writeFileSync(join(shadow, "mesh"), "#!/bin/sh\necho other mesh\n", { mode: 0o755 });
  expect(() => admitHostTool(tools, "mesh", { PATH: shadow })).toThrow("consumer PATH finds mesh");
  const link = join(root, "mesh-link");
  symlinkSync(tools.mesh.path, link);
  expect(() => admitHostTool({ ...tools, mesh: { ...tools.mesh, path: link } }, "mesh", env)).toThrow("expected an absolute regular file");
  chmodSync(tools.flock.path, 0o644);
  expect(() => admitHostTool(tools, "flock", env)).toThrow("not executable");
  appendFileSync(tools.cat.path, "# replaced\n");
  expect(() => admitHostTool(tools, "cat", env)).toThrow("host tool cat changed");
});

/** A replay contract over the fixture's product with fresh, short roots the refusals below must never create. */
function freshContract(f: TlsFixture, harness: HarnessIdentity): { path: string; contract: ReplayContract } {
  const base = parseReplay(JSON.parse(readFileSync(f.replay, "utf8")));
  const short = `/tmp/r${process.pid % 100000}`;
  const contract: ReplayContract = { ...base, harness, roots: { output: join(f.root, "replay-output"), private: join(f.root, "replay-private"), browserTmp: short } };
  const path = join(f.root, "REPLAY-FRESH.json");
  writeFileSync(path, JSON.stringify(contract, null, 2) + "\n");
  return { path, contract };
}
test("the replay operation refuses a wrong pin and a harness that is not the running controller before claiming its output", async () => {
  const { f, harness } = await harnessFixture();
  const { path, contract } = freshContract(f, harness);
  const signal = new AbortController().signal;
  await expect(replay(path, sha256("other"), signal, recorded(harness))).rejects.toThrow("replay contract bytes differ from the pinned SHA-256");
  const read = recorded(harness);
  const outcome = await replay(path, fileIdentity(path).sha256, signal, read);
  expect(String(outcome.error)).toContain("not the harness checkout");
  expect(read.reads).toEqual([]);
  expect(outcome.cleanup).toMatchObject({ drained: true, survivors: [], retained: [], removalFailed: [], sourceClean: true });
  for (const root of Object.values(contract.roots)) expect(existsSync(root)).toBe(false);
});
