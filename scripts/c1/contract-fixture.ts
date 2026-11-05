import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { completePublicationArtifactPaths, executableMemberPaths } from "../producer-closure.ts";
import { DONOR_NAMES, TOOL_NAMES, type ConsumerDependencies, type FileIdentity, type InputManifest, type ParentIntake, type ReleaseTuple, type SourceIdentity, type TreeIdentity } from "./contract.ts";
import { admitIntake, buildHandoff, readSealedDelivery, sealDelivery } from "./delivery.ts";
import { fileIdentity, sha256, treeIdentity } from "./identity.ts";

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

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
}
function payload(path: string): string {
  if (executableMemberPaths().includes(path)) return `#!/bin/sh\necho ${FIXTURE_LAUNCHER_OUTPUT}\n`;
  return path.endsWith(".json") ? `${JSON.stringify({ fixture: path })}\n` : `fixture ${path}\n`;
}
export function writeFixtureDelivery(root: string): void {
  for (const path of completePublicationArtifactPaths()) write(join(root, path), payload(path));
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
  return { browsers: fixtureTree(root, "browsers"), tls: { status: "unresolved", missing: "pg 8.16.3 tarball, complete installed tree and frozen lock not yet authenticated" },
    relay: { status: "unresolved", missing: "relay requirements beyond unit 6 are not defined yet" } };
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

export interface ContractFixture {
  readonly delivery: string;
  readonly intake: string;
  readonly handoff: string;
  readonly inputs: string;
}
/** Build every contract file under `root`, which must not exist yet. */
export function writeContractFixture(root: string): ContractFixture {
  mkdirSync(root, { mode: 0o700 });
  const inputsPath = join(root, "inputs.json");
  write(inputsPath, JSON.stringify(fixtureInputManifest(join(root, "input-files")), null, 2) + "\n");
  const deliveryRoot = join(root, "artifact/delivery");
  writeFixtureDelivery(deliveryRoot);
  const identity = sealDelivery(deliveryRoot, { source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, configSha256: sha256("fixture config"), inputsSha256: fileIdentity(inputsPath).sha256 });
  const delivery = readSealedDelivery(deliveryRoot);
  const intake: ParentIntake = { schema: "bun-wasm.c1-intake/1", kind: "independent-parent-byte-admission", owner: "fixture parent", at: "2026-11-05T00:00:00.000Z",
    deliveryRoot, delivery: identity, source: FIXTURE_SOURCE, tuple: FIXTURE_TUPLE, members: delivery.manifest.files.length, admitted: true };
  const intakePath = join(root, "INTAKE.json");
  write(intakePath, JSON.stringify(intake, null, 2) + "\n");
  const admitted = admitIntake(intakePath, fileIdentity(intakePath).sha256, delivery);
  const handoffPath = join(root, "qualification/handoff.json");
  const handoff = buildHandoff(delivery, admitted.identity, fixtureDependencies(join(root, "dependencies")), join(root, "qualification"), join(root, "b"));
  write(handoffPath, JSON.stringify(handoff, null, 2) + "\n");
  return { delivery: deliveryRoot, intake: intakePath, handoff: handoffPath, inputs: inputsPath };
}

if (import.meta.main) {
  const [target, ...extra] = process.argv.slice(2);
  if (!target || extra.length) throw new Error("Usage: bun scripts/c1/contract-fixture.ts NEW_DIRECTORY");
  process.stdout.write(JSON.stringify(writeContractFixture(resolve(target)), null, 2) + "\n");
}
