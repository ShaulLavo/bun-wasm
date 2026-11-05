import { chmodSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executableMemberPaths, handoffMemberPaths, requireCompletePublicationFiles } from "../producer-closure.ts";
import {
  CONSUMERS, DELIVERY_STATUS, EXECUTABLE_ROLES, HANDOFF_ROLES, SEALED_DIRECTORY_MODE, SEALED_EXECUTABLE_MODE, SEALED_FILE_MODE,
  parseDelivery, parseIntake, sameSource, sameTuple,
  type ConsumerDependencies, type ConsumerHandoff, type ConsumerName, type DeliveryManifest, type FileIdentity, type HandoffRole, type MemberIdentity,
  type ParentIntake, type ReleaseTuple, type SealedMode, type SourceIdentity,
} from "./contract.ts";
import { fileIdentity, sameBytes, sha256 } from "./identity.ts";

class DeliveryError extends Error {}
const MANIFEST = "DELIVERY.json";

/** The mode the registry assigns a member. Input mode bits and names never decide it. */
function sealedMode(path: string): SealedMode {
  return executableMemberPaths().includes(path) ? SEALED_EXECUTABLE_MODE : SEALED_FILE_MODE;
}
function octal(mode: number): string { return `0${(mode & 0o7777).toString(8)}`; }

function walk(root: string, path = ""): string[] {
  return readdirSync(join(root, path)).sort().flatMap(name => {
    const member = path ? `${path}/${name}` : name;
    const stat = lstatSync(join(root, member));
    if (stat.isDirectory()) return walk(root, member);
    if (!stat.isFile()) throw new DeliveryError(`delivery contains a symlink or special file: ${member}`);
    return [member];
  });
}
function directories(root: string, path = ""): string[] {
  const entries = readdirSync(join(root, path), { withFileTypes: true }).filter(entry => entry.isDirectory());
  return entries.flatMap(entry => directories(root, path ? `${path}/${entry.name}` : entry.name)).concat([path]);
}

/** Every payload file with its bytes and registry-assigned sealed mode. The manifest is never a member. */
export function deliveryMembers(root: string): MemberIdentity[] { return treeMembers(root, [MANIFEST]); }

export interface SealFacts {
  readonly source: SourceIdentity;
  readonly tuple: ReleaseTuple;
  readonly configSha256: string;
  readonly inputsSha256: string;
}
/**
 * Write DELIVERY.json exactly once over the complete payload, then seal:
 * registry executables 0555, other files 0444, directories 0555. Returns the
 * manifest identity for the outer result record.
 */
export function sealDelivery(root: string, facts: SealFacts): FileIdentity {
  const files = deliveryMembers(root);
  requireCompletePublicationFiles(files);
  const manifest: DeliveryManifest = { schema: "bun-wasm.c1-delivery/1", status: DELIVERY_STATUS, ...facts, files, parentByteIntake: null, consumerAcceptance: null, deployment: null };
  return sealTree(root, MANIFEST, manifest, files);
}
/**
 * The seal mechanics shared by production and rehearsal: write the inventory
 * file exactly once, then apply the registry modes. `members` must not list
 * the inventory file itself.
 */
export function sealTree(root: string, inventory: string, value: unknown, members: readonly MemberIdentity[]): FileIdentity {
  writeFileSync(join(root, inventory), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  for (const file of members) chmodSync(join(root, file.path), Number.parseInt(file.mode, 8));
  chmodSync(join(root, inventory), Number.parseInt(SEALED_FILE_MODE, 8));
  for (const path of directories(root)) chmodSync(join(root, path), SEALED_DIRECTORY_MODE);
  return fileIdentity(join(root, inventory));
}
/** Payload members excluding any named historical inventory files. */
export function treeMembers(root: string, exclude: readonly string[]): MemberIdentity[] {
  return walk(root).filter(path => !exclude.includes(path)).map(path => {
    const file = fileIdentity(join(root, path));
    return { path, bytes: file.bytes, sha256: file.sha256, mode: sealedMode(path) };
  });
}

function requireMember(root: string, member: MemberIdentity): void {
  if (member.mode !== sealedMode(member.path)) throw new DeliveryError(`manifest mode ${member.mode} differs from the registry for ${member.path}`);
  const path = join(root, member.path);
  const mode = octal(lstatSync(path).mode);
  if (mode !== member.mode) throw new DeliveryError(`sealed mode of ${member.path} is ${mode}, expected ${member.mode}`);
  if (!sameBytes(fileIdentity(path), member)) throw new DeliveryError(`delivery member changed: ${member.path}`);
}
function requireSealedDirectories(root: string): void {
  for (const path of directories(root)) {
    const mode = lstatSync(join(root, path)).mode & 0o7777;
    if (mode !== SEALED_DIRECTORY_MODE) throw new DeliveryError(`sealed directory ${path || "."} has mode ${octal(mode)}`);
  }
}
export interface SealedDelivery { readonly root: string; readonly manifest: DeliveryManifest; readonly identity: FileIdentity }
/** A complete, closed, unchanged sealed delivery with exactly the registry's modes. */
export function readSealedDelivery(root: string): SealedDelivery {
  const identity = fileIdentity(join(root, MANIFEST));
  const manifest = parseDelivery(JSON.parse(readFileSync(identity.path, "utf8")));
  if (octal(lstatSync(identity.path).mode) !== SEALED_FILE_MODE) throw new DeliveryError("DELIVERY.json is not sealed 0444");
  requireCompletePublicationFiles(manifest.files);
  const actual = walk(root).filter(path => path !== MANIFEST).sort();
  const listed = manifest.files.map(file => file.path).sort();
  if (actual.join("\0") !== listed.join("\0")) throw new DeliveryError("delivery has missing or extra files");
  for (const member of manifest.files) requireMember(root, member);
  requireSealedDirectories(root);
  return { root, manifest, identity };
}

/**
 * The independent intake must name this exact delivery: root, manifest
 * bytes, source, tuple and member count. Its own bytes are pinned by the
 * caller. Any other delivery's intake, including an older closure's, refuses.
 */
export function admitIntake(path: string, expectedSha256: string, delivery: SealedDelivery): { readonly intake: ParentIntake; readonly identity: FileIdentity } {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedSha256) throw new DeliveryError("intake record bytes differ from the pinned SHA-256");
  const intake = parseIntake(JSON.parse(bytes.toString("utf8")));
  if (intake.deliveryRoot !== delivery.root || intake.delivery.path !== delivery.identity.path) throw new DeliveryError("intake names a different delivery");
  if (!sameBytes(intake.delivery, delivery.identity)) throw new DeliveryError("intake names a different DELIVERY.json");
  if (!sameSource(intake.source, delivery.manifest.source) || !sameTuple(intake.tuple, delivery.manifest.tuple)) throw new DeliveryError("intake source or tuple differs from the delivery");
  if (intake.members !== delivery.manifest.files.length) throw new DeliveryError("intake member count differs from the delivery");
  return { intake, identity: fileIdentity(path) };
}

/** The read-only consumer view of an admitted delivery. Executables are used from their sealed paths. */
export function buildHandoff(delivery: SealedDelivery, intake: FileIdentity, dependencies: ConsumerDependencies, outputRoot: string, browserTmp: string): ConsumerHandoff {
  const paths = handoffMemberPaths();
  const members = new Map(delivery.manifest.files.map(file => [file.path, file]));
  const artifact = (role: HandoffRole): FileIdentity => {
    const member = members.get(paths[role]);
    if (!member) throw new DeliveryError(`delivery has no ${role} member`);
    return { path: join(delivery.root, member.path), bytes: member.bytes, sha256: member.sha256 };
  };
  const outputs = Object.fromEntries(CONSUMERS.map(name => [name, join(outputRoot, name)])) as Record<ConsumerName, string>;
  return { schema: "bun-wasm.c1-handoff/1", source: delivery.manifest.source, tuple: delivery.manifest.tuple,
    delivery: { root: delivery.root, manifest: delivery.identity }, intake,
    artifacts: Object.fromEntries(HANDOFF_ROLES.map(role => [role, artifact(role)])) as Record<HandoffRole, FileIdentity>,
    webRoot: join(delivery.root, "split/web"), dependencies, outputs, browserTmp };
}

/**
 * What a consumer checks before using a handoff: every artifact still has its
 * bytes and its sealed mode. A consumer never chmods a sealed file; a 0444
 * executable is a refusal, not something to repair.
 */
export function requireHandoffArtifacts(handoff: ConsumerHandoff): void {
  for (const role of HANDOFF_ROLES) {
    const artifact = handoff.artifacts[role];
    if (!sameBytes(fileIdentity(artifact.path), artifact)) throw new DeliveryError(`handoff ${role} changed: ${artifact.path}`);
    const mode = octal(lstatSync(artifact.path).mode);
    const expected = EXECUTABLE_ROLES.includes(role) ? SEALED_EXECUTABLE_MODE : SEALED_FILE_MODE;
    if (mode !== expected) throw new DeliveryError(`handoff ${role} has mode ${mode}, expected sealed ${expected}`);
  }
}
