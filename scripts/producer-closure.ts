import { accessSync, constants, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pairedEngines, programProfile, type SupportedPairedEngine } from "../src/engine-kind.ts";
import type { ProgramProfile } from "./src/program-profile.ts";
import { DELIVERY_RECORDS, EXECUTABLE_ROLES, type HandoffRole } from "./c1/contract.ts";
import waffleRelease from "./waffle-release-inputs.json";
import webPackage from "../web/package.json";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface ProducerSource { readonly head: string; readonly tree: string }
interface LauncherReceipt {
  readonly source: ProducerSource;
  readonly artifact: { readonly sha256: string; readonly bytes: number };
}
const producerFeatures = ["engine-split", "bun-transpiler", "bun-build"];
const groupEngines: readonly SupportedPairedEngine[] = ["quickjs"];
export function producerEngines(profile: ProgramProfile): readonly SupportedPairedEngine[] {
  return profile === "split" ? pairedEngines : groupEngines;
}
export function producerScopes(profile: ProgramProfile): readonly ("core" | SupportedPairedEngine)[] {
  const scopes: ("core" | SupportedPairedEngine)[] = ["core"];
  return scopes.concat(producerEngines(profile));
}
export function producerSelection(profile: ProgramProfile) {
  return profile === "split" ? { features: producerFeatures } : { features: producerFeatures, profile };
}
export function producerArtifactPaths(profile: ProgramProfile): string[] {
  const engines = producerEngines(profile);
  const paths = ["inputs/programs.json", "core/bun-core.wasm", "core/bun-core.wasm.core.json", "launcher/bun-wasm", "launcher/bun-wasm.launcher.json"];
  return paths.concat(engines.flatMap(engine => {
    const names = programProfile(engine);
    return [`${engine}/engine.wasm`, `${engine}/engine.wasm.engine.json`, `dist/${names.core}`, `dist/${names.core}.build.json`, `dist/${names.side}`, `dist/${names.side}.engine.json`, `${engine}-smoke.log`].concat(profile === "split" ? [`${engine}-node-smoke.log`] : []);
  }), profile === "split" ? ["dist/bun-jsc.wasm.embedding.json", "dist/bash-web-shell.wasm", "dist/bash-web-env.wasm", "dist/bash-web-guests.json", "web/index.html", "web/engine-builds.json", "hook-controls.log", "hook-smoke.json"] : ["core/cxx-runtime-members.json", "worker-proof.log"], profile === "split" ? publicationAssets.map(name => `web/${name}.gz`) : []);
}
function isWebClosureAsset(path: string): boolean {
  if (!path.startsWith("web/")) return false;
  if (!/\.wasm(?:\.|$)/.test(path)) return true;
  return /^web\/programs\/(?:shell-engine|env)\.wasm$/.test(path)
    || /^web\/(?:__bunwasm\/)?(?:chunks\/)?network\.wasm$/.test(path)
    || /^web\/programs\/base\/waffle-(?:coreutils|findutils|grep|ripgrep|sed)\/dist\/[^/]+\.wasm(?:\.(?:br|gz))?$/.test(path);
}
export function requireClosureFiles(profile: ProgramProfile, files: readonly { readonly path: string }[]): void {
  for (const file of files) rejectWithdrawnPublicationPath(file.path);
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length) throw new Error("Repeated producer manifest path");
  const required = new Set(producerArtifactPaths(profile));
  for (const path of required) if (!paths.has(path)) throw new Error(`Missing producer manifest artifact: ${path}`);
  for (const path of paths) {
    if (required.has(path) || (profile === "split" && isWebClosureAsset(path))) continue;
    throw new Error(`Unexpected producer manifest artifact: ${path}`);
  }
}
/** Output names only. Dormant repository source remains valid provenance, never a shipped guest. */
export function rejectWithdrawnPublicationPath(path: string): void {
  if (/(?:^|[/.\\_-])hermes(?:$|[/.\\_-])/i.test(path)) throw new Error(`Withdrawn engine publication artifact: ${path}`);
}
/** The outer publication owns these guests separately from the paired-core producer. */
export const publicationGuestPaths = {
  browser: "browser/default/bun-browser.wasm",
  "source-cache-browser": "browser/source-cache/bun-browser.wasm",
  tools: "tools/bun-tools.wasm",
} as const;
const publicationPaired: readonly (SupportedPairedEngine | "browser")[] = pairedEngines;
export const publicationEngines: readonly (SupportedPairedEngine | "browser")[] = publicationPaired.concat(["browser"]);
export const publicationAssets: readonly string[] = pairedEngines.flatMap<string>(engine => {
  const profile = programProfile(engine);
  return [profile.core, profile.side];
}).concat(["bun-browser.wasm", "bun-tools.wasm"]);

/** Reject partial or extended asset registries, including stale withdrawn-engine references. */
export function verifyPublicationBuilds(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid publication asset registry");
  const names = Object.keys(value);
  if (names.length !== publicationAssets.length || names.some(name => !publicationAssets.includes(name))) throw new Error("Publication asset registry must contain only the complete supported engine assets");
  for (const name of publicationAssets) {
    const fingerprint: unknown = Reflect.get(value, name);
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`Invalid publication asset fingerprint: ${name}`);
  }
}

/** A release archive the selected source pins, and where the delivery keeps it. */
export interface SelectedArchive { readonly version: string; readonly url: string; readonly path: string }
function archiveName(url: string, label: string): string {
  const name = new URL(url).pathname.split("/").at(-1);
  if (!name?.endsWith(".tgz")) throw new Error(`${label} pin is not a release archive URL: ${url}`);
  return name;
}
/**
 * The runtime and relay archives this source selects: runtime from its Waffle
 * release record, relay from the Web package pin. Delivery paths follow the
 * pinned file names, so a different release is a different member.
 */
export function selectedReleaseArchives(): { readonly runtime: SelectedArchive; readonly relay: SelectedArchive } {
  const relayUrl = webPackage.dependencies["waffle-relay"];
  const relayVersion = /\/waffle-v([0-9][^/]*)\/waffle-relay-\1\.tgz$/.exec(relayUrl)?.[1];
  if (!relayVersion) throw new Error(`Web relay pin is not a Waffle relay release: ${relayUrl}`);
  return {
    runtime: { version: waffleRelease.version, url: waffleRelease.url, path: `runtime/${archiveName(waffleRelease.url, "Runtime")}` },
    relay: { version: relayVersion, url: relayUrl, path: `relay/${archiveName(relayUrl, "Relay")}` },
  };
}

/**
 * The TLS consumer's page, built before sealing from the selected source:
 * its entry, the maintained worker realms beside it, and the guest-side pg
 * client fixture it serves. Chunks and maps under the page root vary by build
 * and are bound by the page receipt.
 */
export const tlsPagePaths: {
  readonly root: string; readonly index: string; readonly entry: string; readonly receipt: string; readonly pgClient: string; readonly workers: readonly string[];
} = {
  root: "tls/page", index: "tls/page/index.html", entry: "tls/page/tls-relay-page.js", receipt: "tls/page.build.json", pgClient: "tls/fixture/pg-client.ts",
  workers: ["tls/page/worker.js", "tls/page/fs-worker.js", "tls/page/notification-worker.js"],
};

/** Delivery members behind every consumer handoff role. */
export function handoffMemberPaths(): Readonly<Record<HandoffRole, string>> {
  const quickjs = programProfile("quickjs");
  const jsc = programProfile("jsc");
  const archives = selectedReleaseArchives();
  return {
    quickjsGuest: `split/dist/${quickjs.core}`, quickjsGuestReceipt: `split/dist/${quickjs.core}.build.json`,
    quickjsSide: `split/dist/${quickjs.side}`, quickjsSideReceipt: `split/dist/${quickjs.side}.engine.json`,
    jscGuest: `split/dist/${jsc.core}`, jscGuestReceipt: `split/dist/${jsc.core}.build.json`,
    jscSide: `split/dist/${jsc.side}`, jscSideReceipt: `split/dist/${jsc.side}.engine.json`, jscEmbeddingReceipt: `split/dist/${jsc.core}.embedding.json`,
    launcher: "split/launcher/bun-wasm", launcherReceipt: "split/launcher/bun-wasm.launcher.json",
    shell: "split/dist/bash-web-shell.wasm", envUtility: "split/dist/bash-web-env.wasm", shellReceipt: "split/dist/bash-web-guests.json",
    browserGuest: publicationGuestPaths.browser, browserGuestReceipt: `${publicationGuestPaths.browser}.build.json`,
    sourceCacheBrowserGuest: publicationGuestPaths["source-cache-browser"], sourceCacheBrowserGuestReceipt: `${publicationGuestPaths["source-cache-browser"]}.build.json`,
    toolsGuest: publicationGuestPaths.tools, toolsGuestReceipt: `${publicationGuestPaths.tools}.build.json`,
    webIndex: "split/web/index.html", engineBuilds: "split/web/engine-builds.json", producerManifest: "split/manifest.json",
    sourceArchive: "source.tar.gz", runtimeArchive: archives.runtime.path, relayArchive: archives.relay.path,
    programManifest: "inputs/programs-release/program-release.json", programChecksums: "inputs/programs-release/SHA256SUMS",
    fd3Artifact: "inputs/network/preview1-relay.fd3.wasm", fd3Receipt: "inputs/network/RECEIPT.json",
    config: DELIVERY_RECORDS.config, inputs: DELIVERY_RECORDS.inputs, environment: DELIVERY_RECORDS.environment, stages: DELIVERY_RECORDS.stages,
    tlsPageIndex: tlsPagePaths.index, tlsPageEntry: tlsPagePaths.entry, tlsPageReceipt: tlsPagePaths.receipt, tlsPgClient: tlsPagePaths.pgClient,
  };
}

/** The only delivery members sealed executable (0555). Everything else is sealed 0444. */
export function executableMemberPaths(): readonly string[] {
  const paths = handoffMemberPaths();
  return EXECUTABLE_ROLES.map(role => paths[role]);
}

/** Required outer delivery files. Existing byte, actor, matrix and custody validators still apply. */
export function completePublicationArtifactPaths(): string[] {
  const guests = Object.values(publicationGuestPaths).flatMap(path => [path, `${path}.build.json`]);
  const custody = ["before", "after", "preseal"].flatMap(phase => [
    `inputs/${phase}.json`, `inputs/vendor-custody-${phase}.json`, `inputs/native-custody-${phase}.json`,
  ]);
  const handoff = Object.values(handoffMemberPaths());
  return Array.from(new Set(producerArtifactPaths("split").map(path => `split/${path}`).concat(guests, custody, handoff, tlsPagePaths.workers,
    [
      "inputs/publication-matrix.json", "split/hook-cleanup.json", "inputs/NATIVE-CANDIDATE-ADMISSION.json", "inputs/browser-consumer.json",
      "inputs/vendor-bun.bundle", "inputs/vendor-bundle-proof.json",
      "native/jsc/.bunwasm-artifacts", "native/jsc/.bunwasm-inputs", "native/jsc/native-header-manifest.json",
      "native/jsc/build/jsc/CMakeCache.txt", "native/jsc/build/jsc/cmakeconfig.h", "native/jsc/build/jsc/compile_commands.json",
      "native/jsc/inputs/wasi-jsc.cmake", "native/jsc/inputs/shim/wasi-compat.h", "native/jsc/inputs/shim/wasi-compat.c", "native/jsc/inputs/shim/madvise.c",
    ])));
}

export function requireCompletePublicationFiles(files: readonly { readonly path: string }[]): void {
  for (const file of files) rejectWithdrawnPublicationPath(file.path);
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length) throw new Error("Repeated publication manifest path");
  for (const path of completePublicationArtifactPaths()) if (!paths.has(path)) throw new Error(`Missing complete publication artifact: ${path}`);
}

/** JSC and the shared sysroot retain their existing original-input admission checks. */
export function verifyPublicationNativeBacking(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "jsc,sysroot") throw new Error("Publication native backing must contain only JSC and the sysroot");
  for (const name of ["jsc", "sysroot"]) {
    const path: unknown = Reflect.get(value, name);
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`Invalid publication native backing: ${name}`);
  }
}

export const workerProofLabels = ["worker-to-main wake", "worker plain store visible in main", "main-to-worker wake", "worker read main's store and answered", "buffer posted on the port aliases", "timed-out", "not-equal", "alias worker exit", "blocked worker started", "terminate cancels a blocked futex wait", "20 sequential members settled", "main still owns the buffer"];
export function verifyWorkerProof(output: string, status: number | null): void {
  const lines = output.split("\n").filter(line => line.startsWith("PASS "));
  if (status !== 0 || /^FAIL /m.test(output) || lines.length !== workerProofLabels.length
    || workerProofLabels.some((label, index) => lines[index] !== `PASS ${label}` && !lines[index]?.startsWith(`PASS ${label} `))) throw new Error("Shared-group worker proof failed");
}
/** Producer members a manifest names, relative to the engine root so a copy verifies where it lies. */
export const producerLauncherPath = "launcher/bun-wasm";
export const producerLauncherReceiptPath = "launcher/bun-wasm.launcher.json";
export const producerWebRoot = "web";
/** Resolve a manifest-recorded member under `root`. Absolute, traversing or empty segments are refused. */
export function producerMember(root: string, value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")
    || value.split("/").some(part => part === "" || part === "." || part === "..")) throw new Error(`Producer manifest ${label} must be a relative member path`);
  return `${root}/${value}`;
}
/**
 * The manifest's launcher record must name the producer's own launcher and
 * receipt by relative path and match that original receipt and these bytes.
 */
export function verifyManifestLauncher(root: string, value: unknown, source: ProducerSource): LauncherReceipt {
  if (!value || typeof value !== "object" || !("path" in value) || !("receipt" in value)) throw new Error("Manifest launcher record is missing");
  if (value.path !== producerLauncherPath || value.receipt !== producerLauncherReceiptPath) throw new Error("Manifest launcher must name the producer's own relative launcher and receipt");
  const launcher = producerMember(root, value.path, "launcher");
  const verified = verifyLauncher(launcher, JSON.parse(readFileSync(producerMember(root, value.receipt, "launcher receipt"), "utf8")), source);
  if (JSON.stringify(value) !== JSON.stringify({ path: producerLauncherPath, receipt: producerLauncherReceiptPath, ...verified })) throw new Error("Manifest launcher differs from its original receipt");
  return verified;
}

export function launcherReceipt(path: string, source: ProducerSource): LauncherReceipt {
  accessSync(path, constants.X_OK);
  const bytes = readFileSync(path);
  return { source, artifact: { sha256: hash(bytes), bytes: bytes.byteLength } };
}
export function verifyLauncher(path: string, value: unknown, source: ProducerSource): LauncherReceipt {
  if (!value || typeof value !== "object" || !("source" in value) || !("artifact" in value)) throw new Error("Invalid launcher receipt");
  const expected = launcherReceipt(path, source);
  const origin = value.source;
  const artifact = value.artifact;
  if (!origin || typeof origin !== "object" || !("head" in origin) || !("tree" in origin)
    || origin.head !== source.head || origin.tree !== source.tree) throw new Error("Launcher source differs from its original receipt");
  if (!artifact || typeof artifact !== "object" || !("sha256" in artifact) || !("bytes" in artifact)
    || artifact.sha256 !== expected.artifact.sha256 || artifact.bytes !== expected.artifact.bytes) throw new Error("Launcher artifact differs from its original receipt");
  return expected;
}
