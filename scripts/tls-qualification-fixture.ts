import { appendFileSync, chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { handoffMemberPaths, publicationAssets } from "./producer-closure.ts";
import { DELIVERY_RECORDS, type C1Config, type ConsumerHandoff, type InputManifest, type ParentIntake, type ReleaseTuple, type SourceIdentity } from "./c1/contract.ts";
import { FIXTURE_TUPLE, fixtureDependencies, fixtureInputManifest, writeFixtureDelivery } from "./c1/contract-fixture.ts";
import { buildHandoff, readSealedDelivery, sealDelivery } from "./c1/delivery.ts";
import { fileIdentity, sha256, treeIdentity } from "./c1/identity.ts";
import type { TlsEvidence } from "./tls-qualification-inputs.ts";

/**
 * Synthetic parser fixture for the TLS consumer, never product evidence: a
 * clean host checkout, donor and pg trees, and a sealed delivery built with
 * the controller's own fixture, seal, intake and handoff exports. Overrides
 * change one fact before sealing; tests tamper after sealing.
 */
export interface FixtureOverrides {
  readonly tuple?: ReleaseTuple;
  readonly deliverySource?: SourceIdentity;
  readonly inputs?: (inputs: InputManifest) => InputManifest;
  readonly config?: (config: C1Config) => C1Config;
  readonly members?: Readonly<Record<string, string>>;
  readonly intake?: (intake: ParentIntake) => unknown;
  readonly handoff?: (handoff: ConsumerHandoff) => unknown;
}
function ledger(row: object): void {
  const path = process.env.TLS_SOURCE_RESOURCE_LEDGER;
  if (path) appendFileSync(path, JSON.stringify(row) + "\n");
}
function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o600 });
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim(); }

const projectFiles = { "package.json": json({ name: "fixture", private: true }), "bun.lock": "synthetic frozen lock\n" };
/** A clean reviewed checkout with the tracked files TLS binds. */
function hostCheckout(root: string): SourceIdentity {
  const files: Record<string, string> = { ".gitignore": "node_modules\n", "web/src/net/relay.ts": "export {};\n", "web/src/runner.ts": "export {};\n" };
  for (const [name, content] of Object.entries(projectFiles)) { files[name] = content; files[`web/${name}`] = content; }
  for (const [name, content] of Object.entries(files)) put(join(root, name), content);
  execFileSync("git", ["init", "-q", root]);
  git(root, "add", "-A");
  git(root, "-c", "user.email=tls@test.invalid", "-c", "user.name=TLS fixture", "commit", "-qm", "synthetic reviewed source");
  return { head: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
}
/** Donor node_modules installed from the host's frozen files, and their staged copies in the host. */
function hostDonors(root: string, host: string) {
  const trees = { rootDependencies: { directory: "", modules: { "playwright/package.json": json({ version: "synthetic" }) } },
    webDependencies: { directory: "web", modules: { "waffle/package.json": json({ version: "0.0.110" }), "waffle-relay/package.json": json({ version: "0.0.109" }), "waffle-relay/node.ts": "export {};\n" } } };
  return Object.fromEntries(Object.entries(trees).map(([name, tree]) => {
    const project = join(root, "donors", name);
    for (const [file, content] of Object.entries(projectFiles)) put(join(project, file), content);
    for (const [file, content] of Object.entries(tree.modules)) put(join(project, "node_modules", file), content);
    cpSync(join(project, "node_modules"), join(host, tree.directory, "node_modules"), { recursive: true });
    return [name, treeIdentity(join(project, "node_modules"))];
  }));
}
/** A pg project with a transitive dependency and the public tarball its pg package came from. */
function pgProject(root: string) {
  const project = join(root, "pg-project");
  const pg = { "package.json": json({ name: "pg", version: "8.16.3" }), "lib/index.ts": "export {};\n" };
  for (const [file, content] of Object.entries(projectFiles)) put(join(project, file), content);
  for (const [file, content] of Object.entries(pg)) { put(join(project, "node_modules/pg", file), content); put(join(root, "pg-public/package", file), content); }
  put(join(project, "node_modules/pg-protocol/index.ts"), "export {};\n");
  execFileSync("tar", ["-czf", join(root, "pg-8.16.3.tgz"), "-C", join(root, "pg-public"), "package"]);
  return { pgTarball: fileIdentity(join(root, "pg-8.16.3.tgz")), pgModules: treeIdentity(join(project, "node_modules")),
    pgPackageJson: fileIdentity(join(project, "package.json")), pgLock: fileIdentity(join(project, "bun.lock")) };
}

/** Payload replacements so the sealed delivery agrees with its records and retained inputs. */
function consistentMembers(inputs: InputManifest, configBytes: string, inputsBytes: string): Record<string, string> {
  const paths = handoffMemberPaths();
  const custody = ["", "native-custody-", "vendor-custody-"].flatMap(family => ["before", "after", "preseal"].map(phase => [`inputs/${family}${phase}.json`, json({ synthetic: family || "source" })]));
  return Object.fromEntries(custody.concat([
    [DELIVERY_RECORDS.config, configBytes], [DELIVERY_RECORDS.inputs, inputsBytes],
    [paths.runtimeArchive, readFileSync(inputs.runtime.archive.path, "utf8")], [paths.relayArchive, readFileSync(inputs.relay.archive.path, "utf8")],
    [paths.engineBuilds, json(Object.fromEntries(publicationAssets.map(name => [name, "c".repeat(64)])))],
  ]));
}

export function qualificationFixture(overrides: FixtureOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-tls-parser-"));
  ledger({ created: root, kind: "synthetic-parser-only" });
  try { return prepare(root, overrides); }
  catch (error) { removeFixture(root); throw error; }
}
function prepare(root: string, overrides: FixtureOverrides) {
  const host = join(root, "host");
  const source = hostCheckout(host);
  const donors = hostDonors(root, host);
  const base = fixtureInputManifest(join(root, "input-files"));
  const dependencies = fixtureDependencies(join(root, "dependencies"));
  const manifest: InputManifest = { ...base, source, donors: { ...base.donors, ...donors }, consumers: { ...dependencies, tls: { status: "resolved", value: pgProject(root) } } };
  const inputs = (overrides.inputs ?? (value => value))(manifest);
  const inputsBytes = json(inputs);
  put(join(root, "inputs.json"), inputsBytes);
  const roots = { run: { report: join(root, "run/report"), artifact: join(root, "run/artifact"), private: join(root, "run/private"), browserTmp: join(root, "rb") },
    qualify: { output: join(root, "qualification"), private: join(root, "q-private"), browserTmp: join(root, "qb") } };
  const config = (overrides.config ?? (value => value))({ schema: "bun-wasm.c1-config/1", sourceRoot: host, manifest: fileIdentity(join(root, "inputs.json")), roots, jobs: 4 });
  const configBytes = json(config);
  const deliveryRoot = join(roots.run.artifact, "delivery");
  writeFixtureDelivery(deliveryRoot);
  for (const [path, content] of Object.entries({ ...consistentMembers(inputs, configBytes, inputsBytes), ...overrides.members })) put(join(deliveryRoot, path), content);
  const manifestIdentity = sealDelivery(deliveryRoot, { source: overrides.deliverySource ?? source, tuple: overrides.tuple ?? FIXTURE_TUPLE, configSha256: sha256(configBytes), inputsSha256: sha256(inputsBytes) });
  const delivery = readSealedDelivery(deliveryRoot);
  const intake: ParentIntake = { schema: "bun-wasm.c1-intake/1", kind: "independent-parent-byte-admission", owner: "synthetic TLS fixture parent", at: "2026-11-05T00:00:00.000Z",
    deliveryRoot, delivery: manifestIdentity, source: delivery.manifest.source, tuple: delivery.manifest.tuple, members: delivery.manifest.files.length, admitted: true };
  const intakePath = join(root, "INTAKE.json");
  put(intakePath, json((overrides.intake ?? (value => value))(intake)));
  const handoff = buildHandoff(delivery, fileIdentity(intakePath), inputs.consumers, roots.qualify.output, roots.qualify.browserTmp);
  const handoffPath = join(roots.qualify.output, "handoff.json");
  put(handoffPath, json((overrides.handoff ?? (value => value))(handoff)));
  const evidence: TlsEvidence = { handoff: handoffPath, intakeSha256: fileIdentity(intakePath).sha256, reviewedSource: source };
  return { root, host, source, delivery: deliveryRoot, intake: intakePath, handoff: handoffPath, inputs, evidence, put, close: () => removeFixture(root) };
}
export type TlsFixture = ReturnType<typeof qualificationFixture>;

/** Test-owned cleanup: this fixture's own sealed directories are made writable only to delete them. */
function release(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) release(join(path, entry));
}
function removeFixture(root: string): void {
  release(root);
  rmSync(root, { recursive: true, force: true });
  if (lstatSync(root, { throwIfNoEntry: false })) throw new Error("TLS parser fixture retained");
  ledger({ absent: root });
}
