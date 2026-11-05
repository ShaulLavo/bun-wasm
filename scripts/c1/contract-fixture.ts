import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { completePublicationArtifactPaths, executableMemberPaths } from "../producer-closure.ts";
import {
  DELIVERY_RECORDS, DONOR_NAMES, TOOL_NAMES, parseDelivery, type C1Config, type ConsumerDependencies, type ConsumerHandoff, type FileIdentity, type InputManifest, type ParentIntake,
  type ReleaseTuple, type SourceIdentity, type TlsFixtureOptions, type TreeIdentity,
} from "./contract.ts";
import type { LoadedObservation } from "./loaded.ts";
import { admitIntake, buildHandoff, readSealedDelivery, sealDelivery } from "./delivery.ts";
import { fileIdentity, sha256, treeIdentity } from "./identity.ts";
import { HOST_TOOL_NAMES, NOT_RERUN, type HostTool, type HostToolName, type HostTools, type ReplayContract, type ReplayRoots } from "./replay.ts";

/**
 * Executable schema fixture: a synthetic sealed delivery with every registry
 * member, its independent intake record, the handoff the controller derives
 * from both, and an input manifest that still carries draft entries. No byte
 * here is a product artifact. Consumer owners run it to see the exact shapes:
 *
 *   bun scripts/c1/contract-fixture.ts /work/tmp/<new directory>
 */
export const FIXTURE_SOURCE: SourceIdentity = { head: "1".repeat(40), tree: "2".repeat(40) };
export const FIXTURE_TUPLE: ReleaseTuple = { runtime: "0.0.110", relay: "0.0.109", programs: "programs-v0.0.15", programManifestSchema: "waffle-program-release/2", hostInterface: 1 };
/** The synthetic launcher: a real executable that prints this line. */
export const FIXTURE_LAUNCHER_OUTPUT = "c1-fixture-launcher";

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
}
function payload(path: string): string | Uint8Array {
  if (executableMemberPaths().includes(path)) return `#!/bin/sh\necho ${FIXTURE_LAUNCHER_OUTPUT}\n`;
  // Served compressed members are real gzip, so decoded observations can be bound to them.
  if (path.endsWith(".gz")) return Bun.gzipSync(new TextEncoder().encode(`fixture ${path.slice(0, -3)}\n`));
  return path.endsWith(".json") ? `${JSON.stringify({ fixture: path })}\n` : `fixture ${path}\n`;
}
export function writeFixtureDelivery(root: string): void {
  for (const path of completePublicationArtifactPaths().concat(["split/web/worker.js"])) write(join(root, path), payload(path));
}
function fixtureFile(root: string, name: string): FileIdentity {
  write(join(root, name), `fixture input ${name}\n`);
  return fileIdentity(join(root, name));
}
function fixtureTree(root: string, name: string): TreeIdentity {
  write(join(root, name, "entry"), `fixture tree ${name}\n`);
  return treeIdentity(join(root, name));
}
export function fixtureDependencies(root: string): ConsumerDependencies {
  return { browsers: fixtureTree(root, "browsers"), tls: { status: "unresolved", missing: "pg 8.16.3 tarball, complete installed tree and frozen lock not yet authenticated" } };
}
/** A parseable manifest whose native and consumer entries are honestly draft. */
export function fixtureInputManifest(root: string): InputManifest {
  const draft = (missing: string) => ({ status: "draft", missing }) as const;
  const native = (name: string, missing: string) => ({ root: join(root, "native", name), files: [fixtureFile(root, `native-${name}-receipt.json`)], provenance: draft(missing) });
  return {
    schema: "bun-wasm.c1-inputs/1", source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE,
    runtime: { archive: fixtureFile(root, "waffle-0.0.110.tgz"), authentication: fixtureFile(root, "RUNTIME-INPUT.json") },
    relay: { archive: fixtureFile(root, "waffle-relay-0.0.109.tgz"), provenance: draft("selected-source relay checks not yet run") },
    programs: { manifest: fixtureFile(root, "program-release.json"), checksums: fixtureFile(root, "SHA256SUMS"), archives: [fixtureFile(root, "waffle-base-0.0.15.tgz")] },
    fd3: { artifact: fixtureFile(root, "preview1-relay.fd3.wasm"), receipt: fixtureFile(root, "RECEIPT.json") },
    native: { jsc: native("jsc", "current jsc/common.sh stamp not admitted"), sdk: native("sdk", "current helper validation not run"),
      sysroot: native("sysroot", "current helper validation not run"), shell: native("shell", "bash-web fc8327a3 guests not admitted") },
    donors: Object.fromEntries(DONOR_NAMES.map(name => [name, fixtureTree(join(root, "donors"), name)])) as InputManifest["donors"],
    tools: Object.fromEntries(TOOL_NAMES.map(name => [name, fixtureFile(join(root, "tools"), name)])) as InputManifest["tools"],
    consumers: fixtureDependencies(root),
  };
}

/** Synthetic, clearly fictional TLS choices that pass validation. Real host and addresses stay unresolved until admitted. */
export const FIXTURE_TLS_OPTIONS: TlsFixtureOptions = { databaseMachine: "fixture-database", databaseAddress: "10.255.0.1", relayAddress: "10.255.0.2", pagePort: 43839, relayPort: 43840 };
export function fixtureConfig(root: string, manifest: FileIdentity): C1Config {
  return { schema: "bun-wasm.c1-config/1", sourceRoot: join(root, "source"), manifest, jobs: 2,
    roots: { run: { report: join(root, "run-report"), artifact: join(root, "artifact"), private: join(root, "run-private"), browserTmp: "/work/tmp/c1" },
      qualify: { output: join(root, "qualification"), private: join(root, "q-private"), browserTmp: "/work/tmp/c2" } },
    fixtures: { tls: { status: "resolved", value: FIXTURE_TLS_OPTIONS } } };
}
/** Observations a real consumer would record for these members: decoded bytes of what the page received. */
function observed(origin: string, path: string, file: string, encoding: LoadedObservation["encoding"]): LoadedObservation {
  const bytes = encoding === "gzip" ? Bun.gunzipSync(readFileSync(`${file}.gz`)) : readFileSync(file);
  return { url: `${origin}${path}`, method: "GET", status: 200, encoding, bytes: bytes.byteLength, sha256: sha256(bytes) };
}
function fixtureLoaded(handoff: ConsumerHandoff) {
  const origin = "http://127.0.0.1:43839";
  const web = [observed(origin, "/", join(handoff.webRoot, "index.html"), "identity"), observed(origin, "/bun-browser.wasm", join(handoff.webRoot, "bun-browser.wasm"), "gzip"),
    observed(origin, "/bun.wasm", join(handoff.webRoot, "bun.wasm"), "gzip"), observed(origin, "/worker.js", join(handoff.webRoot, "worker.js"), "identity")];
  const guest = handoff.artifacts.browserGuest;
  const tls = [observed(origin, "/", join(handoff.tlsPageRoot, "index.html"), "identity"), observed(origin, "/tls-relay-page.js", join(handoff.tlsPageRoot, "tls-relay-page.js"), "identity"),
    observed(origin, "/fs-worker.js", join(handoff.tlsPageRoot, "fs-worker.js"), "identity"), observed(origin, "/pg-client.ts", handoff.artifacts.tlsPgClient.path, "identity"),
    { url: `${origin}/artifact/${guest.sha256}`, method: "GET", status: 200, encoding: "identity", bytes: guest.bytes, sha256: guest.sha256 } as const,
    { url: `${origin}/seed`, method: "GET", status: 200, encoding: "identity", bytes: 2, sha256: sha256("[]") } as const];
  return { web: { loaded: web }, tls: { loaded: tls } };
}

/** A stub host tool that only prints its name. */
function stubTool(root: string, name: HostToolName): HostTool {
  const path = join(root, name);
  write(path, `#!/bin/sh\necho fixture ${name}\n`);
  chmodSync(path, 0o755);
  return { ...fileIdentity(path), version: { args: ["--version"], line: `fixture ${name}` } };
}
/** This machine's own tool, for fixtures that really read a .tgz. */
function localTool(name: HostToolName): HostTool {
  const found = Bun.which(name);
  if (!found) throw new Error(`fixture needs a local ${name}`);
  const path = realpathSync(found);
  const line = spawnSync(path, ["--version"], { encoding: "utf8" }).stdout.split("\n")[0] ?? "";
  return { ...fileIdentity(path), version: { args: ["--version"], line } };
}
/** Declared host tools for synthetic fixtures: tar and gzip are this machine's own, every other tool a stub. */
export function fixtureHostTools(root: string): HostTools {
  return Object.fromEntries(HOST_TOOL_NAMES.map(name => [name, name === "tar" || name === "gzip" ? localTool(name) : stubTool(root, name)])) as Record<HostToolName, HostTool>;
}
export interface ReplayFixtureParts {
  /** New directory for the contract, review artifact, stub tools and original output. */
  readonly root: string;
  readonly config: string;
  readonly intake: string;
  readonly delivery: string;
  readonly harness: { readonly sourceRoot: string; readonly source: SourceIdentity };
  readonly roots: ReplayRoots;
}
/**
 * A replay contract over a sealed fixture delivery, with a synthetic review
 * artifact and original output, and the replay handoff whose product view
 * is `product` (normally the one buildHandoff derives; tests may edit it).
 */
export function writeReplayFixture(parts: ReplayFixtureParts, product: unknown): { readonly replay: string; readonly handoff: string } {
  const { root, harness } = parts;
  const sealed = parseDelivery(JSON.parse(readFileSync(parts.delivery, "utf8")));
  const review = join(root, "review/RESULT.md");
  write(review, `# Synthetic review\n\nPASS\n\nCandidate ${harness.source.head}, tree ${harness.source.tree}.\n`);
  const original = join(root, "original");
  write(join(original, "handoff.json"), "{}\n");
  write(join(original, "QUALIFICATION.json"), "{}\n");
  for (const engine of NOT_RERUN) write(join(original, "five-owner", engine, "result.json"), `${JSON.stringify({ fixture: engine })}\n`);
  const contract: ReplayContract = { schema: "bun-wasm.c1-replay/1",
    product: { config: fileIdentity(parts.config), intake: fileIdentity(parts.intake), delivery: fileIdentity(parts.delivery), source: sealed.source, tuple: sealed.tuple, members: sealed.files.length },
    harness: { ...harness, repository: "fixture/bun-wasm", pullRequest: 1, review: { artifact: fileIdentity(review), candidate: harness.source } },
    original: { output: original, handoff: fileIdentity(join(original, "handoff.json")), qualification: fileIdentity(join(original, "QUALIFICATION.json")) },
    hostTools: fixtureHostTools(join(root, "host-tools")), roots: parts.roots };
  const replay = join(root, "REPLAY.json");
  write(replay, JSON.stringify(contract, null, 2) + "\n");
  const handoff = join(parts.roots.output, "handoff.json");
  write(handoff, JSON.stringify({ schema: "bun-wasm.c1-replay-handoff/1", replay: fileIdentity(replay), harness: contract.harness, hostTools: contract.hostTools, product }, null, 2) + "\n");
  return { replay, handoff };
}

export interface ContractFixture {
  readonly delivery: string;
  readonly intake: string;
  /** The replay handoff consumers receive. */
  readonly handoff: string;
  readonly replay: string;
  readonly inputs: string;
  readonly config: string;
  readonly loadedWeb: string;
  readonly loadedTls: string;
}
/**
 * A synthetic delivery whose sealed CONFIG and INPUTS members are the real
 * config and input manifest bytes its DELIVERY.json binds, at the root that
 * config names. Everything else in it is filler, never a product artifact.
 */
export function writeFixtureRecords(deliveryRoot: string, configBytes: string, inputsBytes: string): { readonly configSha256: string; readonly inputsSha256: string } {
  writeFileSync(join(deliveryRoot, DELIVERY_RECORDS.config), configBytes);
  writeFileSync(join(deliveryRoot, DELIVERY_RECORDS.inputs), inputsBytes);
  return { configSha256: sha256(configBytes), inputsSha256: sha256(inputsBytes) };
}
export interface SealedFixture { readonly inputsPath: string; readonly configPath: string; readonly config: C1Config; readonly deliveryRoot: string; readonly identity: FileIdentity }
/**
 * Config, input manifest and a sealed synthetic delivery at the root that
 * config names, under `root` (which must not exist). `beforeSeal` may change
 * payload files before the single seal.
 */
export function writeSealedFixture(root: string, beforeSeal: (deliveryRoot: string) => void = () => {}): SealedFixture {
  mkdirSync(root, { mode: 0o700 });
  const inputsPath = join(root, "inputs.json");
  const inputsBytes = JSON.stringify(fixtureInputManifest(join(root, "input-files")), null, 2) + "\n";
  write(inputsPath, inputsBytes);
  const configPath = join(root, "config.json");
  const config = fixtureConfig(root, fileIdentity(inputsPath));
  const configBytes = JSON.stringify(config, null, 2) + "\n";
  write(configPath, configBytes);
  const deliveryRoot = join(config.roots.run.artifact, "delivery");
  writeFixtureDelivery(deliveryRoot);
  const records = writeFixtureRecords(deliveryRoot, configBytes, inputsBytes);
  beforeSeal(deliveryRoot);
  const identity = sealDelivery(deliveryRoot, { source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, ...records });
  return { inputsPath, configPath, config, deliveryRoot, identity };
}
/** Build every contract file under `root`, which must not exist yet. */
export function writeContractFixture(root: string): ContractFixture {
  const { inputsPath, configPath, config, deliveryRoot, identity } = writeSealedFixture(root);
  const delivery = readSealedDelivery(deliveryRoot);
  const intake: ParentIntake = { schema: "bun-wasm.c1-intake/1", kind: "independent-parent-byte-admission", owner: "fixture parent", at: "2026-11-05T00:00:00.000Z",
    deliveryRoot, delivery: identity, source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, members: delivery.manifest.files.length, admitted: true };
  const intakePath = join(root, "INTAKE.json");
  write(intakePath, JSON.stringify(intake, null, 2) + "\n");
  const admitted = admitIntake(intakePath, fileIdentity(intakePath).sha256, delivery);
  const roots = config.roots.qualify;
  const handoff = buildHandoff(delivery, admitted.identity, delivery.inputs.consumers, delivery.config.fixtures, roots.output, roots.browserTmp);
  const replay = writeReplayFixture({ root: join(root, "replay"), config: configPath, intake: intakePath, delivery: identity.path,
    harness: { sourceRoot: config.sourceRoot, source: FIXTURE_SOURCE }, roots }, handoff);
  const loaded = fixtureLoaded(handoff);
  const loadedWeb = join(roots.output, "five-owner-loaded.json"), loadedTls = join(roots.output, "tls-loaded.json");
  write(loadedWeb, JSON.stringify(loaded.web, null, 2) + "\n");
  write(loadedTls, JSON.stringify(loaded.tls, null, 2) + "\n");
  return { delivery: deliveryRoot, intake: intakePath, handoff: replay.handoff, replay: replay.replay, inputs: inputsPath, config: configPath, loadedWeb, loadedTls };
}

if (import.meta.main) {
  const [target, ...extra] = process.argv.slice(2);
  if (!target || extra.length) throw new Error("Usage: bun scripts/c1/contract-fixture.ts NEW_DIRECTORY");
  process.stdout.write(JSON.stringify(writeContractFixture(resolve(target)), null, 2) + "\n");
}
