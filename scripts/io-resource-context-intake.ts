import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HANDOFF_ROLES, SEALED_DIRECTORY_MODE, SEALED_EXECUTABLE_MODE, SEALED_FILE_MODE, parseConfig, parseInputManifest, sameSource, sameTuple, type ConsumerHandoff, type FileIdentity } from "./c1/contract.ts";
import type { SealedDelivery } from "./c1/delivery.ts";
import { inside, requireFile, requireTree, sameBytes, sha256 } from "./c1/identity.ts";
import { admitReplayHandoffFile, requireHarnessCheckout, requireReplayHandoff, type ReplayHandoff } from "./c1/replay.ts";
import { executableMemberPaths, handoffMemberPaths, selectedReleaseArchives, verifyPublicationBuilds } from "./producer-closure.ts";
import { expectedBrowserPayload } from "./io-resource-context-assets.ts";
import { requiredGuestCompanions, verifyGuestBuildReceipt, verifyGuestCompanions, type GuestBuildReceipt } from "./guest-build-receipt.ts";
import release from "./waffle-release-inputs.json";

/** `handoff` is the product view of the sealed delivery; `replay` carries the separate harness identity and host tools. */
export interface PinnedHandoff { readonly kind: "handoff"; readonly handoff: ConsumerHandoff; readonly reference: FileIdentity; readonly delivery: SealedDelivery; readonly replay: ReplayHandoff }

/** Check registry mode and every sealed ancestor at each actual delivery read boundary. */
export function requireFiveOwnerMember(pinned: PinnedHandoff, path: string): FileIdentity {
  const root = pinned.delivery.root;
  const member = pinned.delivery.manifest.files.find(file => join(root, file.path) === path);
  if (!member || !inside(root, path) || resolve(path) !== path) throw new Error("Five-owner read is not an admitted delivery member");
  const mode = executableMemberPaths().includes(member.path) ? SEALED_EXECUTABLE_MODE : SEALED_FILE_MODE;
  const stat = lstatSync(path);
  if (!stat.isFile() || member.mode !== mode || (stat.mode & 0o7777) !== Number.parseInt(mode, 8)) throw new Error("Five-owner sealed member mode changed");
  let directory = dirname(path);
  for (;;) {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || (parent.mode & 0o7777) !== SEALED_DIRECTORY_MODE) throw new Error("Five-owner sealed directory mode changed");
    if (directory === root) return { ...member, path };
    directory = dirname(directory);
  }
}

export function readFiveOwnerMember(pinned: PinnedHandoff, path: string): Buffer {
  const member = requireFiveOwnerMember(pinned, path);
  const bytes = readFileSync(path);
  if (bytes.length !== member.bytes || sha256(bytes) !== member.sha256) throw new Error("Five-owner delivered read bytes changed");
  requireFiveOwnerMember(pinned, path);
  return bytes;
}

/** Representations are selected by the maintained server; only listed members may back a response. */
export function requireFiveOwnerResponse(pinned: PinnedHandoff, url: string): void {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const path = resolve(pinned.handoff.webRoot, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
  if (!inside(pinned.handoff.webRoot, path)) throw new Error(`Loaded response leaves the admitted Web root: ${url}`);
  const paths = [path].concat([`${path}.gz`, `${path}.br`]);
  const members = pinned.delivery.manifest.files.filter(member => paths.includes(join(pinned.delivery.root, member.path)));
  if (!members.length) throw new Error(`Loaded response has no admitted representation: ${url}`);
  for (const member of members) readFiveOwnerMember(pinned, join(pinned.delivery.root, member.path));
}

/** Whole sealed closure, the replay contract and pinned external anchors are rechecked at prelaunch and after teardown. */
export function recheckFiveOwnerHandoff(pinned: PinnedHandoff): void {
  requireFile(pinned.reference, "five-owner handoff");
  const product = requireReplayHandoff(pinned.replay);
  if (!sameBytes(product.delivery.identity, pinned.delivery.identity)) throw new Error("Five-owner delivery manifest changed");
}

/** Only the current replay contract; no historical admission or mode translation. */
export function readFiveOwnerHandoff(path: string, expectedSha256: string): PinnedHandoff {
  const admitted = admitReplayHandoffFile(path, expectedSha256);
  const handoff = admitted.handoff.product;
  const { delivery } = admitted.product;
  const paths = handoffMemberPaths();
  for (const role of HANDOFF_ROLES) {
    if (handoff.artifacts[role].path !== join(delivery.root, paths[role])) throw new Error(`Handoff ${role} leaves its registry member`);
  }
  if (handoff.webRoot !== dirname(handoff.artifacts.webIndex.path)) throw new Error("Handoff Web root differs from its registry");
  const archives = selectedReleaseArchives();
  const expected = { runtime: archives.runtime.version, relay: archives.relay.version, programs: release.programs.tag,
    programManifestSchema: release.programs.schema, hostInterface: release.hostInterface };
  if (!sameTuple(handoff.tuple, expected)) throw new Error("Handoff tuple is not the selected source tuple");
  return { kind: "handoff", handoff, reference: admitted.reference, delivery, replay: admitted.handoff };
}

/**
 * The consumer runs from the merged harness checkout named by the replay, a
 * separate identity from the product source; the product's sealed config and
 * inputs are bound to the delivery that seals them.
 */
export function bindFiveOwnerSource(pinned: PinnedHandoff, sourceRoot: string): void {
  const { handoff, delivery } = pinned;
  requireHarnessCheckout(pinned.replay.harness, sourceRoot);
  const config = parseConfig(JSON.parse(readFiveOwnerMember(pinned, handoff.artifacts.config.path).toString("utf8")));
  const inputs = parseInputManifest(JSON.parse(readFiveOwnerMember(pinned, handoff.artifacts.inputs.path).toString("utf8")));
  if (handoff.artifacts.config.sha256 !== delivery.manifest.configSha256 || handoff.artifacts.inputs.sha256 !== delivery.manifest.inputsSha256
    || !sameBytes(config.manifest, handoff.artifacts.inputs)) throw new Error("Delivered config/input binding mismatch");
  requireFile(config.manifest, "five-owner original input manifest");
  if (!sameSource(inputs.source, handoff.source) || !sameTuple(inputs.tuple, handoff.tuple)) throw new Error("Delivered input source/tuple mismatch");
  if (!isDeepStrictEqual(handoff.dependencies, inputs.consumers) || !isDeepStrictEqual(handoff.fixtures, config.fixtures)) throw new Error("Handoff dependencies or fixtures differ from selected inputs/config");
  requireTree({ ...inputs.donors.rootDependencies, path: join(sourceRoot, "node_modules") }, "five-owner root dependency view");
}

export function bindFiveOwnerOutput(pinned: PinnedHandoff, surface: "quickjs" | "jsc" | "chromium", output: string): void {
  if (resolve(output) !== join(pinned.handoff.outputs["five-owner"], surface)) throw new Error("Consumer output differs from the selected handoff output");
}

export function bindFiveOwnerBrowser(pinned: PinnedHandoff, sourceRoot: string): void {
  const inputs = parseInputManifest(JSON.parse(readFiveOwnerMember(pinned, pinned.handoff.artifacts.inputs.path).toString("utf8")));
  requireTree({ ...inputs.donors.webDependencies, path: join(sourceRoot, "web/node_modules") }, "five-owner Web dependency view");
  requireTree(pinned.handoff.dependencies.browsers, "five-owner browser inputs");
  requireFile(pinned.handoff.artifacts.engineBuilds, "five-owner engine registry");
  const builds: unknown = JSON.parse(readFiveOwnerMember(pinned, pinned.handoff.artifacts.engineBuilds.path).toString("utf8"));
  verifyPublicationBuilds(builds);
  const payload = expectedBrowserPayload(pinned.handoff.webRoot, path => readFiveOwnerMember(pinned, path));
  if (builds["bun-browser.wasm"] !== pinned.handoff.artifacts.browserGuest.sha256 || !sameBytes(payload, pinned.handoff.artifacts.browserGuest)) throw new Error("Web root does not contain the admitted default Browser guest");
}

export function recheckFiveOwnerBrowser(pinned: PinnedHandoff, executable: string): void {
  requireTree(pinned.handoff.dependencies.browsers, "five-owner browser inputs");
  if (!inside(realpathSync(pinned.handoff.dependencies.browsers.path), realpathSync(executable))) throw new Error("Chromium executable is outside its admitted dependency tree");
}

export async function verifyFiveOwnerGuest(pinned: PinnedHandoff, expected: "quickjs" | "jsc" | "browser"): Promise<GuestBuildReceipt> {
  const guest = pinned.handoff.artifacts[expected === "quickjs" ? "quickjsGuest" : expected === "jsc" ? "jscGuest" : "browserGuest"].path;
  const receipt: unknown = JSON.parse(readFiveOwnerMember(pinned, `${guest}.build.json`).toString("utf8"));
  verifyGuestBuildReceipt(readFiveOwnerMember(pinned, guest), receipt);
  if (receipt.sourceManifest.build !== expected || receipt.profile !== undefined) throw new Error("Guest is not the selected full split/default profile");
  if (!sameSource(receipt.sourceManifest.source, pinned.handoff.source)) throw new Error("Guest receipt is from another source");
  for (const companion of requiredGuestCompanions(receipt)) readFiveOwnerMember(pinned, join(dirname(guest), companion.name));
  await verifyGuestCompanions(receipt, dirname(guest));
  for (const companion of requiredGuestCompanions(receipt)) requireFiveOwnerMember(pinned, join(dirname(guest), companion.name));
  return receipt;
}
